---
title: "Four Files or One: BLite's Bitwise Page Routing"
date: "2026-03-24"
description: "How BLite encodes the file type, collection slot, and local page number into a single uint — and why this self-describing page ID lets the storage engine route reads and writes across multiple memory-mapped files with a bitmask and no schema lookup."
tags: [".net", "blite", "storage-engine", "memory-mapped-files", "bitwise", "performance", "open-source"]
---

Most embedded databases use a single file. Simple, reliable, easy to reason about. But BLite supports four deployment modes — from a single unified file to per-collection files to a client/server split — and the code that handles them is surprisingly small. The trick is encoding routing information directly into the page ID.

---

## The Deployment Problem

An embedded database has competing requirements. A small CLI tool wants a single `.db` file it can copy and delete. A multi-tenant application wants collections to live in separate files so they can be independently backed up or migrated. A server process wants the index in its own file, separate from the data, for different I/O access patterns.

BLite solves this with four named configurations:

```csharp
public static class PageFileConfig
{
    public static Config Embedded(string databasePath) =>
        new(Mode.Embedded, databasePath, null);

    public static Config SeparateIndex(string databasePath) =>
        new(Mode.SeparateIndex, databasePath, null);

    public static Config PerCollection(string databasePath) =>
        new(Mode.PerCollection, databasePath, null);

    public static Config Server(string databasePath) =>
        new(Mode.Server, databasePath, null);
}
```

In `Embedded` mode, everything — data, indexes, metadata — lives in one file. In `SeparateIndex`, the index gets its own file. In `PerCollection`, each collection gets its own file. In `Server`, the storage engine acts as a remote file store managed by a server process.

The challenge: code that writes or reads a page shouldn't need to know which mode it's in. It should just call `ReadPage(pageId)` and get the right bytes, regardless of how many files the data is split across.

---

## The Self-Describing Page ID

BLite encodes the file type, collection slot, and local page number into a single `uint`:

```
Bit 31: index page marker     (1 = index file)
Bit 30: collection page marker (1 when combined with bit 31 = 11)
Bits 29-24: collection slot   (6 bits → up to 64 collections)
Bits 23-0:  local page number  (24 bits → up to 16,777,215 pages per file)
```

The two high bits define the file type:

```csharp
private const uint IndexPageMarker      = 0x8000_0000u; // bit 31: 10xx xxxx ...
private const uint CollectionPageMarker = 0xC000_0000u; // bits 31-30: 11xx xxxx ...
private const uint CollectionSlotMask   = 0x3F00_0000u; // bits 29-24
private const uint LocalPageMask        = 0x00FF_FFFFu; // bits 23-0
private const uint IndexLocalMask       = 0x7FFF_FFFFu; // bits 30-0 (for index files)
```

When `Embedded` mode uses just the main file, page IDs look like plain sequential integers: `1`, `2`, `3`, …. No bits are set in the top positions. When the storage engine allocates an index page, it OR-in the marker:

```csharp
public uint AllocateIndexPage(ITransaction? transaction = null)
{
    uint localId = _indexFile.AllocatePage(transaction);
    return IndexPageMarker | (localId & IndexLocalMask);
}
```

When it allocates a collection page, it also encodes the 6-bit slot:

```csharp
public uint AllocateCollectionPage(string collectionName, ITransaction? transaction = null)
{
    int slot = GetOrAssignCollectionSlot(collectionName);
    uint localId = _collectionFiles[slot].AllocatePage(transaction);
    uint slotBits = (uint)(slot & 0x3F) << 24;
    return CollectionPageMarker | slotBits | (localId & LocalPageMask);
}
```

The result: every `uint` page ID is self-describing. You can look at a page ID and immediately know which file it belongs to, which collection it's in, and what its local offset is — without any schema lookup or dictionary.

---

## The Router: `GetPageFile`

All reads and writes go through a single routing function:

```csharp
private IPageFile GetPageFile(uint pageId, out uint physicalPageId)
{
    if ((pageId & CollectionPageMarker) == CollectionPageMarker)
    {
        // Bits 31-30 = 11 → collection file
        int slot = (int)((pageId & CollectionSlotMask) >> 24);
        physicalPageId = pageId & LocalPageMask;
        return _collectionFiles[slot];
    }
    else if ((pageId & IndexPageMarker) == IndexPageMarker)
    {
        // Bit 31 = 1, bit 30 = 0 → index file
        physicalPageId = pageId & IndexLocalMask;
        return _indexFile;
    }
    else
    {
        // No high bits set → main page file
        physicalPageId = pageId;
        return _mainFile;
    }
}
```

Note the ordering: `CollectionPageMarker` (`0xC000_0000`) is tested before `IndexPageMarker` (`0x8000_0000`) because collection pages have *both* bits set. Testing for `IndexPageMarker` first would incorrectly match collection pages.

The caller gets back the right `IPageFile` and the physical (de-encoded) page number. The routing is two comparisons and two bitmask operations — essentially free at runtime.

---

## File Growth: `AlignToBlock`

File re-sizing is expensive. Every time you extend a file the OS must update metadata, potentially zero-fill new pages, and may trigger a flush. Growing one page at a time is impractical.

BLite grows files in aligned blocks:

```csharp
private static long AlignToBlock(long requiredLength, long blockSize = 1_048_576 /* 1 MB */)
{
    if (requiredLength <= 0) return blockSize;
    long remainder = requiredLength % blockSize;
    return remainder == 0 ? requiredLength : requiredLength + (blockSize - remainder);
}
```

When the storage engine needs a new page and the file isn't large enough, it rounds up the required length to the next 1 MB boundary and resizes in one shot. The new pages in the gap are initialized with a reserved "empty page" marker. This reduces the frequency of OS-level resize operations by roughly three orders of magnitude for typical workloads.

---

## Memory-Mapped Files in .NET

BLite uses `MemoryMappedFile` for all page I/O:

```csharp
_mmf = MemoryMappedFile.CreateFromFile(
    fileStream,
    mapName:    null,
    capacity:   alignedSize,
    access:     MemoryMappedFileAccess.ReadWrite,
    inheritability: HandleInheritability.None,
    leaveOpen:  true
);
_accessor = _mmf.CreateViewAccessor(0, alignedSize, MemoryMappedFileAccess.ReadWrite);
```

Memory-mapped files let the OS kernel manage the page cache. Reading a page doesn't require a `Read` syscall — the page maps directly into the process's virtual address space and is demand-paged from disk on first access. Write-back is also handled by the OS: modified pages are flushed to disk when the OS decides to, or explicitly via `_accessor.Flush()`.

This gives BLite zero-copy reads and the full benefit of OS-level I/O scheduling. The trade-off: you can't easily control *when* dirty pages are flushed, which is why the WAL exists — durability is guaranteed by the log, not by the memory-mapped file.

---

## Immutable Configuration: `record struct` with `with`

Page file configuration is represented as a `record struct` — value semantics, immutable by convention, copy-on-modification via `with`:

```csharp
public readonly record struct Config
{
    public Mode DeploymentMode { get; init; }
    public string DatabasePath { get; init; }
    public string? MapName { get; init; }

    // Example: create a server config with a custom map name
    public Config WithMapName(string mapName) => this with { MapName = mapName };
}
```

`record struct` is a C# 10 feature. It generates `Equals`, `GetHashCode`, and `ToString` based on the fields, and the `with` expression creates a copy with one field changed without mutating the original. This is useful for test setup: start from `PageFileConfig.Embedded(path)` and derive variants for specific test scenarios without shared mutable state.

---

## Concrete Limits

The encoding imposes hard limits worth knowing before committing to BLite:

| Resource | Limit | Why |
|---|---|---|
| Collections per database | 64 | 6-bit slot in bits 29–24 |
| Pages per collection file | 16,777,215 | 24-bit local page number |
| Pages per index file | 536,870,911 | 30-bit local page number (bit 31 claims one) |
| Pages per main file | 536,870,911 | Same, no high bits consumed |

At 4 KB per page, a single collection file can hold up to 64 GB of data. Exceeding that limit requires a schema migration to split the collection across multiple databases, which BLite doesn't yet automate.

---

## What I'd Do Differently

The 64-collection limit is the most likely pain point in practice. A 7-bit slot field (128 collections) would change the encoding but all existing databases would be incompatible — a schema migration is unavoidable either way. Doing this sooner rather than later is the right call.

The per-collection file growth allocates 1 MB at a time, which is reasonable for large collections but wastes space for databases with many small collections. A per-file configurable block size would help, at the cost of more complexity in `AlignToBlock`.

The server mode is currently a stub — the routing code exists but the remote I/O transport does not. If you're using BLite today, `Embedded` and `SeparateIndex` are the only production-ready modes.

---

## The Bottom Line

Encoding file type, collection slot, and local page number into a `uint` is one of those ideas that looks clever until you realize it's just two bitmask checks and some bit-shifts. The result is a routing layer with no heap allocations, no dictionary lookups, and O(1) dispatch from any page ID to the right physical file.

The complete source is on [GitHub](https://github.com/EntglDb/BLite).
