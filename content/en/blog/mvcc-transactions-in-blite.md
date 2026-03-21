---
title: "MVCC Lite: How BLite Gives You Transactions Without a Full Concurrency Engine"
date: "2026-03-31"
description: "How BLite implements transaction isolation using two in-memory dictionaries — a WAL cache for uncommitted writes and a WAL index for committed-but-not-checkpointed pages — and where that falls short of true MVCC."
tags: [".net", "blite", "mvcc", "transactions", "concurrency", "acid", "open-source", "internals"]
---

Every serious database makes the same promise: a transaction either commits fully or doesn't happen at all. Reading data mid-transaction gives you a consistent snapshot, not a half-written mess. And if the process crashes, you don't lose committed data.

Keeping those promises while allowing concurrent readers and writers is the hard part. Most production databases use Multi-Version Concurrency Control — MVCC — to do it. BLite uses a simpler model that gets most of the guarantees with a fraction of the complexity. Here's exactly how it works and where the cracks are.

---

## The Problem MVCC Solves

Without any concurrency control, two transactions reading and writing the same pages simultaneously produce chaos: one transaction reads a page that another is halfway through writing. The fix is to give each transaction its own *view* of the data — a snapshot taken at the moment the transaction started, immune to concurrent modifications.

True MVCC (as in PostgreSQL) does this with version chains: every updated row keeps its old version on disk alongside the new one, tagged with transaction IDs. Readers pick the version whose timestamp is ≤ their transaction start time. Writers never block readers.

This is powerful and general. It's also complex: vacuum processes, tuple headers, transaction ID wraparound, visibility maps. BLite takes a different approach.

---

## Two Dictionaries, One Contract

BLite's transaction isolation is built on two in-memory data structures:

```csharp
// Per-transaction uncommitted writes
private readonly ConcurrentDictionary<ulong, ConcurrentDictionary<uint, byte[]>> _walCache = new();

// Committed-but-not-yet-checkpointed pages (the "stable ring")
private readonly ConcurrentDictionary<uint, byte[]> _walIndex = new();
```

`_walCache` is a dictionary of dictionaries: the outer key is the transaction ID (`ulong`), the inner key is the page ID (`uint`), and the value is the page's byte array. Every write goes into the caller's private cache, invisible to anyone else.

`_walIndex` is a flat dictionary: page ID → current byte array. It represents the committed state of all pages that have been written since the last checkpoint. When you read a page, you first check `_walIndex` for the committed version.

The read path combines both:

```csharp
public byte[] ReadPage(uint pageId, ulong transactionId)
{
    // First: see if this transaction has written the page (read your own writes)
    if (_walCache.TryGetValue(transactionId, out var txnCache) &&
        txnCache.TryGetValue(pageId, out var uncommitted))
        return uncommitted;

    // Second: see if there's a committed version since last checkpoint
    if (_walIndex.TryGetValue(pageId, out var committed))
        return committed;

    // Third: read from the durably persisted page file
    return _pageFile.ReadPage(pageId);
}
```

A transaction always reads its own uncommitted writes. If it hasn't touched a page, it reads from `_walIndex` — the committed state from previous (committed) transactions. If `_walIndex` doesn't have the page either, it falls through to the durable page file.

---

## Transaction Lifecycle

**Begin:** Just allocate a new transaction ID. Nothing else happens yet.

```csharp
public ulong BeginTransaction()
{
    ulong txnId = Interlocked.Increment(ref _transactionCounter);
    _walCache[txnId] = new ConcurrentDictionary<uint, byte[]>();
    return txnId;
}
```

**Write:** Buffer the modified page in the transaction's private cache.

```csharp
public void WritePage(uint pageId, byte[] data, ulong transactionId)
{
    if (!_walCache.TryGetValue(transactionId, out var txnCache))
        throw new InvalidOperationException("No active transaction");

    // Copy so the caller can reuse their buffer
    var copy = new byte[data.Length];
    data.CopyTo(copy, 0);
    txnCache[pageId] = copy;
}
```

**Commit:** Hand off the transaction's dirty pages to the group commit pipeline, which batches them into the WAL, flushes to disk, moves them into `_walIndex`, and completes the `TaskCompletionSource` that the caller is awaiting.

```csharp
public async Task CommitTransactionAsync(ulong transactionId)
{
    if (!_walCache.TryRemove(transactionId, out var txnCache))
        throw new InvalidOperationException("No active transaction");

    var pending = new PendingCommit(transactionId, txnCache, new TaskCompletionSource(
        TaskCreationOptions.RunContinuationsAsynchronously));

    await _commitChannel.Writer.WriteAsync(pending);
    await pending.Completion.Task; // Wait for group commit to finish
}
```

**Abort:** Just remove the transaction's entry from `_walCache`. The dirty pages are gone. Zero I/O.

```csharp
public void AbortTransaction(ulong transactionId)
{
    _walCache.TryRemove(transactionId, out _);
}
```

Rollback being free is a genuine advantage of the WAL cache design. There's no "undo log" to replay, no page reverts to write. The uncommitted data was never made visible to anyone else and simply ceases to exist.

---

## Group Commit: From `_walCache` to `_walIndex`

The group commit loop runs on a dedicated background task:

```csharp
private async Task GroupCommitLoopAsync(CancellationToken ct)
{
    await foreach (var pending in _commitChannel.Reader.ReadAllAsync(ct))
    {
        var batch = new List<PendingCommit> { pending };

        // Drain any additional commits that arrived while we were processing
        while (_commitChannel.Reader.TryRead(out var extra))
            batch.Add(extra);

        // Write all batched pages to the WAL stream (single fsync)
        await using var walLock = await _walLock.LockAsync();

        foreach (var commit in batch)
        {
            WriteCommitToWalStream(commit);
            // Move committed pages to stable index
            foreach (var (pageId, data) in commit.Pages)
                _walIndex[pageId] = data;
        }

        await _walStream.FlushAsync();

        // Signal all waiters *outside* the lock
        foreach (var commit in batch)
            commit.Completion.TrySetResult();
    }
}
```

All transactions in the batch share a single `FlushAsync` call. This is the group commit dividend: instead of one fsync per commit (a ~10ms disk operation), N transactions share one fsync at ~10ms total. At high commit rates, this is the difference between 100 commits/sec and 10,000 commits/sec.

---

## Why `SemaphoreSlim` on the WAL Stream

The WAL stream is shared state. Any concurrent commit loop iteration would corrupt it. BLite uses a `SemaphoreSlim`-backed async lock:

```csharp
private readonly SemaphoreSlim _walLock = new(1, 1);

// Convenience wrapper that disposes the semaphore on exit
private async Task<IDisposable> LockAsync()
{
    await _walLock.WaitAsync();
    return new SemaphoreReleaser(_walLock);
}
```

`SemaphoreSlim` with initial count 1 is the idiomatic async mutex in .NET. Unlike `lock`, it doesn't block a thread while waiting — it yields back to the thread pool, which matters when the lock is held during `FlushAsync` (an async operation that would deadlock under a synchronous lock).

---

## Checkpoint: Collapsing WAL into the Page File

As transactions commit, `_walIndex` grows. Eventually it's large enough that startup time (reapplying the WAL) would be unacceptable during recovery. A checkpoint merges the `_walIndex` into the durable page file and truncates the WAL:

```csharp
private async Task CheckpointInternalAsync(CancellationToken ct)
{
    await using var walLock = await _walLock.LockAsync();

    // Write all stable pages to the page file
    foreach (var (pageId, data) in _walIndex)
        await _pageFile.WritePageAsync(pageId, data, ct);

    await _pageFile.FlushAsync(ct);

    // Now it's safe to truncate the WAL
    _walStream.SetLength(0);
    _walStream.Seek(0, SeekOrigin.Begin);
    _walIndex.Clear();
}
```

Checkpointing is serialized under `_walLock`, which means it blocks the group commit loop. During a checkpoint, incoming commit calls queue up in `_commitChannel` and resume once the lock is released. The lock duration is proportional to the number of dirty pages — another argument for frequent small checkpoints over rare large ones.

---

## Where This Diverges from True MVCC

BLite's model gives you the ACID properties you care about for an embedded database:

- **Atomicity**: uncommitted pages are invisible; rollback is free.
- **Consistency**: constraints are enforced at the document layer before pages are written.
- **Isolation**: each transaction reads a consistent view — its own writes layered on top of the last committed state.
- **Durability**: committed transactions survive a crash because they're in the WAL before the `TrySetResult` fires.

But it's not full MVCC in the database-theory sense:

**No snapshot isolation.** Two concurrent readers do not each see the state of the database at their individual start times. They both read from the same `_walIndex` snapshot — the state as of the last committed transaction. If transaction A reads page 5, then transaction B commits an update to page 5, then transaction A reads page 5 again, it sees B's committed update. This is "read committed" isolation, not "repeatable read" or "serializable."

**Single logical writer.** Commits are serialized through `_commitChannel`. Concurrent transactions can prepare their dirty pages in parallel (each in its own `_walCache` entry) but only one commit makes it through the group commit loop at a time. There's no concurrent write path — the "group" in group commit means batching, not parallelism.

**Readers can stall during checkpoint.** The checkpoint loop holds `_walLock`, which serializes against the commit loop, which serializes against all new commits. A long checkpoint can delay all new commits for the duration. A proper MVCC system would let readers proceed against old versions while the checkpoint writes new ones.

---

## The Bottom Line

For an embedded, single-writer document database, BLite's two-dictionary design is a pragmatic sweet spot. Rollback is a dictionary remove. Reads always see a consistent committed state. Group commit amortizes disk latency across concurrent transactions. And the implementation is small enough to read in an afternoon.

The limitations — read committed isolation, serialized writers, blocking checkpoint — are real. But for the overwhelmingly common case of "one process, sequential or lightly concurrent access," they don't matter in practice.

The complete source is on [GitHub](https://github.com/EntglDb/BLite).
