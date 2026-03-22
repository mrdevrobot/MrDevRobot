---
title: "Multi-File Storage: How BLite Handles Concurrent Server Access"
date: "2026-04-07"
description: "How BLite splits a database across multiple memory-mapped files, uses ReaderWriterLockSlim with a fast-path/slow-path strategy to protect concurrent access, and provides per-connection session isolation — and what could go wrong with these choices."
tags: [".net", "blite", "concurrency", "storage-engine", "memory-mapped-files", "server", "transactions", "open-source"]
---

An embedded database that lives in a single file is fine for a desktop app, a CLI tool, or a mobile game. One process, one thread (usually), one file. But the moment you put a database behind a server — where dozens of connections read and write concurrently — the single-file model starts to crack.

This post is about how BLite went from "one file, one writer at a time" to "multiple files, concurrent readers and writers, per-connection transaction isolation." I'll cover the architecture, the locking strategy that makes it safe, the session model that gives each connection its own transaction context, and the migrations that let you convert between layouts. Then I'll take a step back and talk about where these choices might hurt.

---

## Why Multi-File?

A single-file database has one memory-mapped file backing all I/O. Every read and every write — whether it touches a B+Tree index node, a data page, or a WAL checkpoint — goes through the same `MemoryMappedFile`. When the file needs to grow, the OS-level mapping must be disposed and recreated. During that window, no reader can hold a reference to the old mapping or it risks accessing freed memory.

The problem compounds under load. An index scan locks out a document insert because they share the same file. A checkpoint flushes every dirty page through one bottleneck. A `DROP COLLECTION` leaves a fragmentation hole that can only be reclaimed by rewriting the entire file.

BLite's multi-file layout addresses each of these:

```
mydb.db            ← main data file (pages, metadata, KV store)
mydb.idx           ← separate index file (B+Trees, R-Trees, HNSW)
wal/mydb.wal       ← write-ahead log (optionally on a different disk)
collections/mydb/
  ├── users.db     ← per-collection data file
  ├── orders.db
  └── .slots       ← slot→name registry
```

Index writes no longer block data writes — they go to different files with independent locks. Dropping a collection is a file delete, not a page-level defragmentation. The WAL can live on a dedicated disk for sequential I/O while data and indexes benefit from random-access SSD performance.

---

## The Server Configuration

Enabling multi-file is a one-line change:

```csharp
var config = PageFileConfig.Server(databasePath);
using var engine = new BLiteEngine(databasePath, config);
```

`Server()` is a factory that derives all companion paths from the database path:

```csharp
public static PageFileConfig Server(string databasePath, PageFileConfig? baseConfig = null)
{
    var @base = baseConfig ?? Default;
    return @base with
    {
        WalPath = Path.Combine(
            Path.GetDirectoryName(databasePath) ?? ".",
            "wal",
            Path.GetFileNameWithoutExtension(databasePath) + ".wal"),

        IndexFilePath = Path.ChangeExtension(databasePath, ".idx"),

        CollectionDataDirectory = Path.Combine(
            Path.GetDirectoryName(databasePath) ?? ".",
            "collections",
            Path.GetFileNameWithoutExtension(databasePath))
    };
}
```

On startup, the `StorageEngine` constructor checks each path, creates directories as needed, and opens a separate `PageFile` instance for each component. If a path is `null`, that component stays in the main file — you can separate just the index, just the WAL, or everything.

---

## The Concurrency Challenge: Protecting a MemoryMappedFile

Here's the core problem. A `MemoryMappedFile` in .NET maps a region of a file into the process's virtual address space. Reading a page means creating a `ViewAccessor` over that mapping. But when the file must grow — say, a new page is allocated beyond the current file length — the mapping must be disposed and recreated with a larger capacity. If a reader is still holding a `ViewAccessor` to the old mapping while the writer disposes it, the reader gets an `ObjectDisposedException` or, worse, reads stale memory.

The naive solution is a mutex: one thread at a time, readers and writers alike. That kills throughput. The correct solution uses `ReaderWriterLockSlim`:

```csharp
private readonly ReaderWriterLockSlim _rwLock = new(LockRecursionPolicy.NoRecursion);
```

### Fast Path: Read Lock for Concurrent Access

Most writes don't require file growth — the file has already been pre-allocated in 1 MB blocks. When the file is large enough, both reads and writes acquire only a **read lock**, which allows unlimited concurrency:

```csharp
public void WritePage(uint pageId, ReadOnlySpan<byte> source)
{
    // Fast path: file already large enough — share the mapping with readers
    if (offset + PageSize <= _fileStream!.Length)
    {
        _rwLock.EnterReadLock();
        try { WritePageCore(pageId, source); }
        finally { _rwLock.ExitReadLock(); }
        return;
    }

    // Slow path: file must grow — exclusive lock
    _rwLock.EnterWriteLock();
    try
    {
        EnsureCapacityCore(offset);  // Dispose old MMF, recreate with new size
        WritePageCore(pageId, source);
    }
    finally { _rwLock.ExitWriteLock(); }
}
```

The key insight: `ReaderWriterLockSlim` allows any number of concurrent read-lock holders, but a write lock waits for all readers to release and then blocks new acquisitions. When a write forces file growth, the writer calls `EnsureCapacityCore()`, which disposes the old `MemoryMappedFile` and creates a new one. During this, no reader can be holding a reference to the old mapping — the write lock guarantees it.

### Reads Under Read Lock

The read path is simpler — it always takes a read lock:

```csharp
public void ReadPage(uint pageId, Span<byte> destination)
{
    _rwLock.EnterReadLock();
    try { ReadPageCore(pageId, destination); }
    finally { _rwLock.ExitReadLock(); }
}
```

Multiple readers can execute `ReadPageCore` simultaneously. They're all reading from the same `MemoryMappedFile`. As long as no writer needs to grow the file, there's zero contention.

### Why Not Just a Mutex?

A `Monitor` or `lock` statement serializes *all* operations. With 50 concurrent client connections, that means 49 readers wait while 1 reader completes, even though they could all operate in parallel. `ReaderWriterLockSlim` eliminates this bottleneck for read-heavy workloads — which is the common case for most databases.

### The Async Boundary: SemaphoreSlim

`ReaderWriterLockSlim` has a limitation: it requires the acquiring thread to be the releasing thread. That's incompatible with `async/await`, where the continuation can run on a different thread. For `FlushAsync()` and `BackupAsync()`, BLite uses a `SemaphoreSlim` instead:

```csharp
private readonly SemaphoreSlim _asyncLock = new(1, 1);

public async Task BackupAsync(string destinationPath, CancellationToken ct = default)
{
    await _asyncLock.WaitAsync(ct);
    try
    {
        _fileStream.Flush(flushToDisk: true);
        await _fileStream.CopyToAsync(dst);
        await dst.FlushAsync(ct);
    }
    finally { _asyncLock.Release(); }
}
```

This serializes backup and flush operations without requiring thread affinity. The trade-off is that `SemaphoreSlim` doesn't distinguish readers from writers — but these operations are infrequent enough that the cost is negligible.

### Allocation Under Write Lock

Page allocation modifies shared mutable state — `_nextPageId` and `_firstFreePageId` — so it always needs exclusive access:

```csharp
public uint AllocatePage()
{
    _rwLock.EnterWriteLock();
    try
    {
        if (_firstFreePageId != 0)
        {
            var recycledPageId = _firstFreePageId;
            ReadPageCore(recycledPageId, buffer);
            _firstFreePageId = header.NextPageId;
            UpdateFileHeaderFreePtrCore(_firstFreePageId);
            return recycledPageId;
        }
        var pageId = _nextPageId++;
        EnsureCapacityCore((long)pageId * PageSize);
        return pageId;
    }
    finally { _rwLock.ExitWriteLock(); }
}
```

This is a contention point — two threads allocating pages at the exact same time will serialize. But allocation is rare compared to reads and writes, so the impact is proportional.

---

## Lock Summary

| Operation | Lock Type | Mode | Contention |
|---|---|---|---|
| `ReadPage` | `ReaderWriterLockSlim` | Read | Zero (concurrent with other reads/writes) |
| `WritePage` (no growth) | `ReaderWriterLockSlim` | Read | Zero (concurrent) |
| `WritePage` (growth) | `ReaderWriterLockSlim` | Write | Brief: blocks until all readers release |
| `AllocatePage` / `FreePage` | `ReaderWriterLockSlim` | Write | Rare: serialized per file |
| `FlushAsync` / `BackupAsync` | `SemaphoreSlim` | Exclusive | Infrequent: serialized |
| `Dispose` | Both | Exclusive | Once: shutdown only |

The net effect: under normal load, reads and writes are fully concurrent. Contention only happens when the file must grow or a page is allocated — both of which are amortized by pre-allocation in 1 MB blocks.

---

## Session Isolation: One Connection, One Transaction

With the storage layer protected, the next question is how to give each client connection an independent transaction context. In server mode, multiple clients connect simultaneously, each running their own CRUD operations. They shouldn't see each other's uncommitted writes, and a rollback on one connection shouldn't affect another.

BLite introduces `BLiteSession`:

```csharp
public sealed class BLiteSession : ITransactionHolder, IDisposable
{
    private readonly StorageEngine _storage;
    private readonly ConcurrentDictionary<string, Lazy<DynamicCollection>> _collections = new();
    private ITransaction? _currentTransaction;

    internal BLiteSession(StorageEngine storage)
    {
        _storage = storage;
    }

    public ITransaction BeginTransaction()
    {
        if (CurrentTransaction != null) return CurrentTransaction;
        CurrentTransaction = _storage.BeginTransaction();
        return CurrentTransaction!;
    }

    public void Commit()
    {
        foreach (var lazy in _collections.Values)
            lazy.Value.PersistIndexMetadata();
        if (CurrentTransaction != null)
        {
            try { CurrentTransaction.Commit(); }
            finally { CurrentTransaction = null; }
        }
    }

    public void Rollback()
    {
        if (CurrentTransaction != null)
        {
            try { CurrentTransaction.Rollback(); }
            finally { CurrentTransaction = null; }
        }
    }
}
```

The model:

- **One `BLiteEngine`** per database, shared across all connections.
- **One `BLiteSession`** per client connection, created via `engine.OpenSession()`.
- Each session has its own `_currentTransaction` — uncommitted writes live in the per-transaction WAL cache, invisible to other sessions.
- `Commit()` persists index metadata, commits the transaction, and clears the session's transaction reference.
- `Dispose()` auto-rolls back any uncommitted transaction — if the connection drops, nothing leaks.

```csharp
// Server connection handler:
var engine = new BLiteEngine(dbPath, PageFileConfig.Server(dbPath));

var session1 = engine.OpenSession();  // Client 1
var session2 = engine.OpenSession();  // Client 2

session1.BeginTransaction();
session1.GetOrCreateCollection("users").Insert(doc1);

session2.BeginTransaction();
session2.GetOrCreateCollection("users").Insert(doc2);

// doc1 is invisible to session2, doc2 is invisible to session1

session1.Commit();  // doc1 is now visible to new reads
session2.Rollback(); // doc2 disappears
```

Collections are lazy-loaded per session and cached with `ConcurrentDictionary<string, Lazy<DynamicCollection>>`. The `Lazy<T>` with `LazyThreadSafetyMode.ExecutionAndPublication` guarantees that even if a session creates the same collection from multiple threads (e.g., parallel API handlers), the `DynamicCollection` is constructed exactly once.

---

## Migration: Single to Multi and Back

Switching an existing single-file database to multi-file layout (or vice versa) happens through `BLiteMigration`:

```csharp
// Single → multi-file
BLiteMigration.ToMultiFile(dbPath, PageFileConfig.Server(dbPath));

// Multi-file → single-file
BLiteMigration.ToSingleFile(dbPath, serverConfig, dbPath);
```

The migration:

1. Opens the source database with single-file config.
2. Opens a temporary target with multi-file config.
3. Copies all collections (docs + indexes), KV store entries, and the C-BSON dictionary.
4. Checkpoints the target to flush everything to page files.
5. Atomically replaces the source: `File.Delete(source)` → `File.Move(temp, source)`.

If anything fails mid-migration, the catch block deletes the temp file and re-throws. The original database is untouched until the final atomic swap.

The reverse migration (`ToSingleFile`) is symmetric: it consolidates all per-collection files and the separate index back into a single `.db` file, then cleans up the multi-file components.

```csharp
var tempDbPath = sourcePath + ".migrating";
try
{
    using (var source = new BLiteEngine(sourcePath, sourceConfig))
    using (var target = new BLiteEngine(tempDbPath, targetConfig))
    {
        CopyAll(source, target);
    }
    File.Delete(sourcePath);
    File.Move(tempDbPath, sourcePath);
}
catch
{
    SafeDelete(tempDbPath);
    throw;
}
```

One subtle detail: `CopyAll` calls `target.ImportDictionary(source.GetKeyReverseMap())` before copying documents. BLite's C-BSON format compresses field names via a shared dictionary. Without syncing the dictionary first, raw BSON bytes in the new file would reference dictionary entries that don't exist.

---

## Checkpoint and Recovery Across Files

The WAL is still a single file, even in multi-file mode. But the pages it records carry encoded page IDs — an index page has its `0x80000000` marker, a collection page has `0xC0000000 | slot | localId`. During checkpoint, `GetPageFile()` decodes each page ID and routes the write to the correct file:

```csharp
private void CheckpointInternal()
{
    if (_walIndex.IsEmpty) return;

    foreach (var kvp in _walIndex)
    {
        GetPageFile(kvp.Key, out var physId).WritePage(physId, kvp.Value);
    }

    _pageFile.Flush();
    _indexFile?.Flush();
    if (_collectionFiles != null)
    {
        foreach (var pf in _collectionFiles.Values)
            pf.Flush();
    }

    _walIndex.Clear();
    _wal.Truncate();
}
```

Crash recovery works the same way: on startup, the engine reads the WAL, identifies committed transactions, and replays their writes through the same routing function. Because the page IDs are self-describing, the recovery code doesn't need a separate mapping of "which pages belong to which file" — it's encoded in the ID itself. (I covered the bit encoding in detail in [the bitwise page routing post](/blog/bitwise-page-routing-blite-storage-engine).)

---

## What Could Go Wrong

Design decisions have consequences. Here are the ones that I think about most:

### 1. ReaderWriterLockSlim Has a Thundering Herd Problem

When a `WritePage` call triggers file growth, every pending reader waits. When the write lock is released, all of them rush to re-acquire the read lock simultaneously. Under heavy load with frequent growths (e.g., bulk insert into a new database), this creates a thundering herd effect. The pre-allocation in 1 MB blocks mitigates this — once allocated, the file won't need to grow again for hundreds of pages — but the first growth event on each collection file still triggers the stampede.

An alternative would be a concurrent slot array that readers check with `Volatile.Read` — no lock on the hot path at all. This is what LMDB does with its reader table. The complexity is higher, but the latency tail is shorter.

### 2. Per-Collection Files Multiply File Descriptors

Each collection gets its own `PageFile`, which means its own `FileStream` and `MemoryMappedFile`. A database with 50 collections has 50 open file handles plus the main file, the index, and the WAL — 53 total. On Linux under default `ulimit` settings (1024 file descriptors), this becomes a concern. On Windows it's less of an issue, but handles are still a finite resource.

The 64-collection limit (6-bit slot) acts as a natural cap, but it's a hard limit, not a configurable one. If you need 65 collections, you need a second database.

### 3. Backup Is Inconsistent in Multi-File Mode

`BackupAsync` currently checkpoints and copies the main file. It does *not* copy the index file or per-collection files. A backup taken mid-operation captures the main file state but leaves the other files out of the snapshot. This is a known limitation: a complete backup requires stopping writes and copying all files, or implementing a coordinated snapshot across all `PageFile` instances.

### 4. The Commit Lock is Global

`_commitLock` serializes all commits and checkpoints across all sessions. Two sessions committing to *different* collections still contend on the same `SemaphoreSlim`. With the group commit batcher, this is less painful — dozens of commits can be batched into one WAL flush — but the serialization point remains.

A per-collection commit pathway would eliminate this contention at the cost of a more complex WAL format. The current sequence — write BEGIN, data records, COMMIT for each transaction in order — would need to support interleaved records from concurrent commits. Most production databases do this (WAL records carry transaction IDs for exactly this reason), but it significantly complicates recovery.

### 5. No Read Snapshots Across Sessions

BLite's transaction isolation is based on WAL cache separation: a session sees its own uncommitted writes, plus the latest committed state. But there's no snapshot isolation — if session A reads page X, then session B commits a change to page X, then session A reads page X again, it sees the new version. This is *Read Committed*, not *Repeatable Read* or *Serializable*.

For many server workloads, Read Committed is sufficient. For workloads that need consistent snapshots across a multi-step read (e.g., a report that scans thousands of documents), this could produce inconsistent results if concurrent writes modify the data mid-scan.

---

## The Bottom Line

Multi-file storage in BLite is not about making the engine more complex. It's about removing the shared bottleneck — one file, one lock, one I/O queue — and replacing it with independent files that can be read, written, grown, and deleted independently.

The `ReaderWriterLockSlim` fast-path strategy makes reads and writes concurrent under normal load. `BLiteSession` gives each connection its own transaction scope. `BLiteMigration` lets you switch between layouts without rewriting your application code. And the bit-tagged page IDs tie it all together with zero-allocation routing that survives restarts and crashes.

The limitations are real — backup consistency, global commit serialization, Read Committed semantics — but they're the kind of trade-offs you make consciously when you want to keep an embedded database simple enough to fit in your head.

The complete source is on [GitHub](https://github.com/nicholasosaka/BLite).
