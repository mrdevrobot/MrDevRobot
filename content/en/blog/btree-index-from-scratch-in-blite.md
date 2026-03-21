---
title: "A Page-Based B+Tree from Scratch: How BLite Indexes Your Data"
date: "2026-03-10"
description: "A walkthrough of BLite's B+Tree implementation: page-aligned nodes, struct-based headers, node splitting with ArrayPool, range scans over doubly-linked leaf pages, and the stackalloc trick in the read path."
tags: [".net", "blite", "btree", "indexing", "performance", "storage-engine", "open-source", "internals"]
---

Every embedded database needs a way to answer questions like *find all users where age is between 25 and 35* without scanning every record. For BLite, that answer is a B+Tree — an ordered index structure where each node corresponds to a storage page, and leaf nodes are linked together to support range scans.

This post walks through BLite's B+Tree implementation: the node layout, the split algorithm, how the read and write paths manage their buffers differently, and why leaf nodes carry two pointers instead of one.

---

## Why a Tree and Not a Hash Index

A hash index answers point queries (`WHERE id = 42`) in O(1) and is excellent for exact matches. It can't answer range queries, and it can't return results in sorted order without a full scan and re-sort.

A B-Tree answers range queries (`WHERE age BETWEEN 25 AND 35`) and sorted scans natively. The height of the tree is O(log N), so lookups degrade gracefully as the data set grows. For a database that's going to be queried with LINQ's `OrderBy`, ranges, and `Take`, a tree is the natural choice.

BLite uses a B+Tree specifically, which differs from a B-Tree in that all the actual data values (document locations) live in the leaf nodes. Internal nodes only store separator keys to guide the search. This makes range scans cheaper: once you find the left boundary of a range, you can walk the leaf layer linearly without descending the tree at every step.

---

## A Node Is a Page

BLite's B+Tree is *page-based*: every node — leaf or internal — occupies exactly one storage page. The `StorageEngine` manages page allocation; the B+Tree manages what goes inside those pages.

The first 32 bytes of every page is a generic page header managed by the storage engine. Immediately after that, the B+Tree writes its own node header:

```csharp
public struct BTreeNodeHeader
{
    public uint PageId { get; set; }
    public bool IsLeaf { get; set; }
    public ushort EntryCount { get; set; }
    public uint ParentPageId { get; set; }
    public uint NextLeafPageId { get; set; }
    public uint PrevLeafPageId { get; set; }  // doubly-linked

    public void WriteTo(Span<byte> destination)
    {
        BitConverter.TryWriteBytes(destination[0..4],   PageId);
        destination[4] = (byte)(IsLeaf ? 1 : 0);
        BitConverter.TryWriteBytes(destination[5..7],   EntryCount);
        BitConverter.TryWriteBytes(destination[7..11],  ParentPageId);
        BitConverter.TryWriteBytes(destination[11..15], NextLeafPageId);
        BitConverter.TryWriteBytes(destination[15..19], PrevLeafPageId);
    }

    public static BTreeNodeHeader ReadFrom(ReadOnlySpan<byte> source)
    {
        return new BTreeNodeHeader
        {
            PageId         = BitConverter.ToUInt32(source[0..4]),
            IsLeaf         = source[4] != 0,
            EntryCount     = BitConverter.ToUInt16(source[5..7]),
            ParentPageId   = BitConverter.ToUInt32(source[7..11]),
            NextLeafPageId = BitConverter.ToUInt32(source[11..15]),
            PrevLeafPageId = BitConverter.ToUInt32(source[15..19])
        };
    }
}
```

`BTreeNodeHeader` is a `struct`, not a class. It's 20 bytes of pure data: no heap allocation, no object header, no GC involvement. `WriteTo` and `ReadFrom` work directly on `Span<byte>` and `ReadOnlySpan<byte>`, which means the node header round-trips to disk without allocating anything.

Note the two leaf pointer fields: `NextLeafPageId` and `PrevLeafPageId`. Most B+Tree descriptions only show a forward pointer. The backward pointer lets you scan ranges in reverse — useful for `OrderByDescending` and for range queries where you overshoot the left boundary and need to step back one node.

---

## Inserting an Entry

Each entry in a leaf node is an `(IndexKey, DocumentLocation)` pair. `IndexKey` wraps the raw bytes of the key (making it comparable). `DocumentLocation` is a `(pageId, offset)` pair pointing to the actual document on disk.

The insert path uses `ArrayPool` for its buffer:

```csharp
public void Insert(IndexKey key, DocumentLocation location, ulong? transactionId = null)
{
    var txnId = transactionId ?? 0;

    if (_options.Unique && TryFind(key, out var existingLocation, txnId))
    {
        if (!existingLocation.Equals(location))
            throw new InvalidOperationException("Duplicate key violation for unique index");
        return;
    }

    var path = new List<uint>();
    var leafPageId = FindLeafNodeWithPath(key, path, txnId);

    var pageBuffer = ArrayPool<byte>.Shared.Rent(_storage.PageSize);
    try
    {
        ReadPage(leafPageId, txnId, pageBuffer);
        var header = BTreeNodeHeader.ReadFrom(pageBuffer.AsSpan(32));

        if (header.EntryCount >= MaxEntriesPerNode)
        {
            SplitNode(leafPageId, path, txnId);
            path.Clear();
            leafPageId = FindLeafNodeWithPath(key, path, txnId);
            ReadPage(leafPageId, txnId, pageBuffer);
        }

        InsertIntoLeaf(leafPageId, entry: new IndexEntry(key, location), pageBuffer, txnId);
    }
    finally
    {
        ArrayPool<byte>.Shared.Return(pageBuffer);
    }
}
```

The pattern is consistent throughout the write path: rent a buffer from the pool, use it, return it in `finally`. Since writes are serialized by the transaction locking layer, there's no risk of the same buffer being used concurrently.

`MaxEntriesPerNode` is set to 100 in the test build (deliberately low, to force splits during tests). A production configuration would push this to 400–600, depending on the key and value sizes relative to the page size.

---

## The Read Path: `stackalloc` Instead of `ArrayPool`

The read path — `TryFind` — is different. It doesn't write anything, it's called far more frequently than insert, and it can afford a tighter allocation strategy:

```csharp
public bool TryFind(IndexKey key, out DocumentLocation location, ulong? transactionId = null)
{
    location = default;
    var txnId = transactionId ?? 0;

    var leafPageId = FindLeafNode(key, txnId);

    Span<byte> pageBuffer = stackalloc byte[_storage.PageSize];
    ReadPage(leafPageId, txnId, pageBuffer);

    var header = BTreeNodeHeader.ReadFrom(pageBuffer[32..]);
    var dataOffset = 52; // 32 (page header) + 20 (BTree node header)

    for (int i = 0; i < header.EntryCount; i++)
    {
        var entryKey = ReadIndexKey(pageBuffer, dataOffset);
        if (entryKey.Equals(key))
        {
            var locationOffset = dataOffset + entryKey.Data.Length + 4;
            location = DocumentLocation.ReadFrom(
                pageBuffer.Slice(locationOffset, DocumentLocation.SerializedSize));
            return true;
        }
        dataOffset += 4 + entryKey.Data.Length + DocumentLocation.SerializedSize;
    }

    return false;
}
```

`stackalloc byte[_storage.PageSize]` puts the entire page buffer on the thread stack. For 8 KB pages on a thread with a 1 MB stack, this is comfortable. For 32 KB pages with heavily recursive call stacks, you'd want `ArrayPool` instead — this is a configuration-dependent trade-off that I haven't fully resolved.

The reason to prefer `stackalloc` here is throughput. `TryFind` is the hot path for every LINQ `Where` predicate that hits the index. The difference between a stack allocation (one instruction) and an `ArrayPool.Rent` (a thread-local size-class lookup plus CAS) is small in absolute terms, but adds up across thousands of index lookups per second.

---

## Node Splitting

When a leaf node exceeds `MaxEntriesPerNode`, it has to split. The split procedure is the most complex part of the B+Tree and the most consequential for correctness:

1. Allocate a new page for the right half of the node.
2. Copy the upper half of the entries to the right node.
3. Update the doubly-linked leaf chain: the new right node's `PrevLeafPageId` points back to the original, and the original's `NextLeafPageId` points to the new right node.
4. Push the first key of the right node up to the parent as a separator.
5. If the parent is also full, split the parent recursively (the `path` list tracks the ancestors for exactly this purpose).
6. If splitting reaches the root, create a new root page.

The tree grows upward from the leaves, not downward. The root is the only node that changes tier during a split, and it only loses entries — it never accumulates them. This guarantees balanced height across all leaf nodes.

---

## Range Scans

With doubly-linked leaves, a range scan is a two-step operation:

1. Descend the tree to find the leaf that would contain the left boundary key.
2. Walk the leaf layer forward via `NextLeafPageId`, collecting entries until you pass the right boundary.

```csharp
public IEnumerable<DocumentLocation> RangeScan(
    IndexKey? minKey, IndexKey? maxKey, ulong? transactionId = null)
{
    var txnId = transactionId ?? 0;
    var leafPageId = minKey.HasValue
        ? FindLeafNode(minKey.Value, txnId)
        : FindLeftmostLeaf(txnId);

    while (leafPageId != 0)
    {
        var pageBuffer = ArrayPool<byte>.Shared.Rent(_storage.PageSize);
        try
        {
            ReadPage(leafPageId, txnId, pageBuffer);
            var header = BTreeNodeHeader.ReadFrom(pageBuffer.AsSpan(32));

            var entries = ReadLeafEntries(pageBuffer, header.EntryCount);
            foreach (var entry in entries)
            {
                if (minKey.HasValue && entry.Key.CompareTo(minKey.Value) < 0)
                    continue;
                if (maxKey.HasValue && entry.Key.CompareTo(maxKey.Value) > 0)
                    yield break;
                yield return entry.Location;
            }

            leafPageId = header.NextLeafPageId;
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(pageBuffer);
        }
    }
}
```

`yield return` and `yield break` make this a proper iterator: the caller receives entries one by one, and if they stop iterating early (via `Take(20)` for example), the scan stops without reading the remaining pages.

---

## What I'd Do Differently

**Binary search within leaf nodes**. The current implementation scans entries linearly within a leaf. With `MaxEntriesPerNode = 100`, that's at most 100 comparisons. With a binary search it would be at most 7. For small key sizes this matters, though the effect is dwarfed by page I/O unless pages are warm in memory — which they typically are for hot indexes.

**Column-store leaf layout**. The current leaf stores entries as `(key, location)` pairs interleaved. If you want to scan *only* keys (for a deduplication pass, or to check uniqueness before insertion), you read key and location bytes interleaved. A column-store layout would put all keys contiguous and all locations contiguous, improving cache line utilization for key-only scans. More complexity than it's worth at this stage.

**Configurable `MaxEntriesPerNode` per index**. Right now it's a single constant shared by all indexes. An index on a UUID key has different optimal branching than an index on a tiny `byte` column.

---

## The Bottom Line

The B+Tree is BLite's oldest and most stable component. Page-based nodes keep it tightly integrated with the storage engine. The `struct` header serialization keeps allocations minimal. The read/write path asymmetry — `stackalloc` for reads, `ArrayPool` for writes — is a deliberate performance trade-off. And the doubly-linked leaf chain is the small design detail that makes range queries feel cheap.

The complete source is on [GitHub](https://github.com/EntglDb/BLite).
