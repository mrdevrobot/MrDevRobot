---
title: "Write-Ahead Logging and Group Commit: Durability Without Sacrificing Throughput"
date: "2026-03-03"
description: "How BLite uses a Write-Ahead Log to guarantee durability, and the Group Commit pattern — backed by System.Threading.Channels and TaskCompletionSource — that amortizes the cost of fsync across concurrent transactions."
tags: [".net", "blite", "wal", "transactions", "channels", "durability", "performance", "open-source"]
---

Durability is the D in ACID. It means that once a transaction commits, its effects survive a crash, a power cut, or an OS panic. It also means that every commit must, at some point, force data to stable storage — and that operation is slow.

This post is about the two pieces of BLite that handle durability: the **Write-Ahead Log** that records changes before they're applied to the page file, and the **Group Commit** mechanism that keeps the cost of `fsync` from becoming a throughput bottleneck.

---

## The Core Problem

A database page file is not an append-only structure. Writes update it in place — insert a record into a page, update a field, split a B-Tree node. If the process crashes mid-operation, the page file can be left in a partially-written, inconsistent state.

The classical solution is a **Write-Ahead Log**: before you touch the page file, write a record to an append-only log describing *what you're about to do*. If the process crashes, the log survives (append-only means no partial overwrites). On restart, you replay committed log records to bring the page file up to date, and discard uncommitted ones.

The trade-off is that every commit requires the log to be flushed to disk. On most hardware, a flush (`fsync` or `FlushFileBuffers`) costs between 5 and 30 microseconds for a cold HDD, and 50–200 microseconds on a spinning disk. That ceiling becomes your transaction rate ceiling.

---

## WAL Record Format

BLite's WAL uses five record types:

```csharp
public enum WalRecordType : byte
{
    Begin      = 1,   // 17 bytes: type(1) + txnId(8) + timestamp(8)
    Write      = 2,   // variable: type(1) + txnId(8) + pageId(4) + pageData(N)
    Commit     = 3,   // 17 bytes
    Abort      = 4,   // 17 bytes
    Checkpoint = 5    // 17 bytes
}
```

Fixed-size records (Begin, Commit, Abort, Checkpoint) are always 17 bytes. Write records are variable because they carry a full page's worth of data. This makes crash-recovery scanning straightforward: you read the type byte, branch on it, and know exactly how many bytes to consume.

---

## Two Allocation Strategies: `stackalloc` and `ArrayPool`

Writing a Begin record requires a 17-byte buffer. In the synchronous path, that buffer lives on the stack:

```csharp
private void WriteBeginRecordInternal(ulong transactionId)
{
    Span<byte> buffer = stackalloc byte[17];
    buffer[0] = (byte)WalRecordType.Begin;
    BitConverter.TryWriteBytes(buffer[1..9], transactionId);
    BitConverter.TryWriteBytes(buffer[9..17], DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

    _walStream!.Write(buffer);
}
```

`stackalloc byte[17]` allocates on the thread stack, not the heap. No GC pressure, no object header, no finalization — just 17 bytes that disappear when the method returns.

The async path can't use `stackalloc` because the C# compiler needs to lift local variables into a state machine struct for the `await` suspension points, and `Span<T>` (which `stackalloc` produces) cannot be a field in a class or struct on the heap. The solution is `ArrayPool`:

```csharp
public async ValueTask WriteBeginRecordAsync(ulong transactionId, CancellationToken ct = default)
{
    await _lock.WaitAsync(ct);
    try
    {
        var buffer = ArrayPool<byte>.Shared.Rent(17);
        try
        {
            buffer[0] = (byte)WalRecordType.Begin;
            BitConverter.TryWriteBytes(buffer.AsSpan(1, 8), transactionId);
            BitConverter.TryWriteBytes(buffer.AsSpan(9, 8), DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());

            await _walStream!.WriteAsync(new ReadOnlyMemory<byte>(buffer, 0, 17), ct);
        }
        finally
        {
            ArrayPool<byte>.Shared.Return(buffer);
        }
    }
    finally
    {
        _lock.Release();
    }
}
```

`ArrayPool<T>.Shared.Rent(17)` returns a pooled `byte[]` of at least 17 bytes. The `Return` in the `finally` block puts it back in the pool — the next call reuses the same array. Over a busy transaction loop, this means effectively zero heap allocations for WAL record writing.

The pattern — `stackalloc` in sync paths, `ArrayPool` in async paths — appears throughout BLite's performance-sensitive code. It's a small thing individually, but it eliminates GC pauses in a workload that writes thousands of records per second.

---

## The Group Commit Pattern

Individual `fsync` calls are the bottleneck. The insight behind group commit is that if ten transactions all commit within a few microseconds of each other, you don't need ten flushes — you need one. All ten can share the durability guarantee of a single flush, as long as their WAL records are all present before the flush happens.

BLite implements this with a background writer loop and `System.Threading.Channels`:

```csharp
private sealed class PendingCommit
{
    public readonly ulong TransactionId;
    public readonly ConcurrentDictionary<uint, byte[]>? Pages;
    public readonly TaskCompletionSource<bool> Completion =
        new(TaskCreationOptions.RunContinuationsAsynchronously);

    public PendingCommit(ulong txId, ConcurrentDictionary<uint, byte[]>? pages)
    {
        TransactionId = txId;
        Pages = pages;
    }
}
```

When a transaction commits, it posts a `PendingCommit` to the channel and awaits its `Completion` task:

```csharp
public async Task CommitTransactionAsync(ulong transactionId, CancellationToken ct = default)
{
    _walCache.TryGetValue(transactionId, out var pages);
    var pending = new PendingCommit(transactionId, pages);
    await _commitChannel.Writer.WriteAsync(pending, ct).ConfigureAwait(false);
    await pending.Completion.Task.ConfigureAwait(false);
}
```

The background writer loop — running on a dedicated thread — drains the channel:

```csharp
private async Task GroupCommitWriterAsync(CancellationToken ct)
{
    var batch = new List<PendingCommit>(32);

    while (true)
    {
        batch.Clear();

        // Block until at least one commit arrives
        var first = await _commitChannel.Reader.ReadAsync(ct).ConfigureAwait(false);
        batch.Add(first);

        // Drain any additional commits already queued — no extra I/O cost
        while (batch.Count < 64 && _commitChannel.Reader.TryRead(out var next))
            batch.Add(next);

        await ProcessBatchAsync(batch).ConfigureAwait(false);
    }
}
```

`TryRead` is non-blocking. If there's nothing else in the channel, the batch goes out immediately. If ten transactions arrived while the previous batch was flushing, they all get picked up in the next `TryRead` loop and share a single flush.

---

## Processing the Batch

The flush itself writes all records for the entire batch to the WAL stream, issues one `FlushAsync`, then promotes the pages to the WAL index (making them visible to readers):

```csharp
private async Task ProcessBatchAsync(List<PendingCommit> batch)
{
    await _commitLock.WaitAsync().ConfigureAwait(false);
    Exception? failure = null;
    try
    {
        foreach (var commit in batch)
        {
            if (commit.Pages == null || commit.Pages.IsEmpty)
            {
                await _wal.WriteCommitRecordAsync(commit.TransactionId).ConfigureAwait(false);
            }
            else
            {
                await _wal.WriteBeginRecordAsync(commit.TransactionId).ConfigureAwait(false);
                foreach (var (pageId, data) in commit.Pages)
                    await _wal.WriteDataRecordAsync(commit.TransactionId, pageId, data).ConfigureAwait(false);
                await _wal.WriteCommitRecordAsync(commit.TransactionId).ConfigureAwait(false);
            }
        }

        // ONE flush for the entire batch
        await _wal.FlushAsync().ConfigureAwait(false);

        // Promote to WAL index — now visible to readers
        foreach (var commit in batch)
        {
            if (commit.Pages != null)
            {
                _walCache.TryRemove(commit.TransactionId, out _);
                foreach (var kvp in commit.Pages)
                    _walIndex[kvp.Key] = kvp.Value;
            }
        }

        if (_wal.GetCurrentSize() > MaxWalSize)
            CheckpointInternal();
    }
    catch (Exception ex)
    {
        failure = ex;
    }
    finally
    {
        _commitLock.Release();
    }

    // Signal all waiters — OUTSIDE the lock
    foreach (var commit in batch)
    {
        if (failure != null)
            commit.Completion.TrySetException(failure);
        else
            commit.Completion.TrySetResult(true);
    }
}
```

---

## Why `RunContinuationsAsynchronously` Matters

Look at the `PendingCommit` constructor again:

```csharp
public readonly TaskCompletionSource<bool> Completion =
    new(TaskCreationOptions.RunContinuationsAsynchronously);
```

Without `RunContinuationsAsynchronously`, calling `TrySetResult(true)` on a `TaskCompletionSource` runs the continuation *synchronously on the current thread* — the group commit writer thread. Every transaction waiting on `await pending.Completion.Task` would resume inline, one after another, before `TrySetResult` returns. The writer thread would be blocked doing your application's work while the next batch sits in the channel.

With `RunContinuationsAsynchronously`, continuations are posted to the thread pool and run concurrently. The writer thread finishes signaling all completions immediately and loops back to drain the next batch.

---

## Signaling Outside the Lock

Notice that the loop that calls `TrySetResult` happens *after* `_commitLock.Release()`. This is deliberate.

If you held the lock during signaling, and a continuation tried to acquire the same lock (for example, if it immediately started writing another transaction), you'd deadlock — or at best serialize work that should be parallel. Releasing the lock before signaling ensures that by the time any continuation runs, the lock is already free.

This "signal outside the lock" pattern is a classic in concurrent programming. It's easy to get wrong if you refactor the code without understanding why the signal is where it is.

---

## The Flush Sentinel

MAUI apps suspend to the background while holding open database connections. BLite exposes a method to ensure everything pending is durable before suspension:

```csharp
public async Task FlushPendingCommitsAsync(CancellationToken ct = default)
{
    var sentinel = new PendingCommit(0, null);
    await _commitChannel.Writer.WriteAsync(sentinel, ct).ConfigureAwait(false);
    await sentinel.Completion.Task.ConfigureAwait(false);
}
```

The sentinel has `TransactionId = 0` and no pages. When the writer loop processes it, the commit record path is a no-op, but the flush still happens and the sentinel's `Completion` is set. The caller knows that by the time `FlushPendingCommitsAsync` returns, every commit that was in the channel at call time is on stable storage.

---

## Checkpoint

As transactions accumulate, the WAL grows. Reading a page that was modified long ago requires scanning back through potentially large chunks of WAL history. BLite checkpoints automatically when the WAL exceeds `MaxWalSize`:

```csharp
if (_wal.GetCurrentSize() > MaxWalSize)
    CheckpointInternal();
```

A checkpoint copies all pages from the WAL index back to the main page file, then truncates the WAL. Readers that were holding a reference to a specific WAL snapshot complete against the old data; new readers start from the freshly checkpointed page file.

This is the weakest part of the current design. Checkpoint is a stop-the-world operation — no reads or writes can happen during it. For small embedded databases with predictable workloads, this is acceptable. For anything resembling a server workload, you'd want a fuzzy or online checkpoint (as PostgreSQL has had since 8.0).

---

## The Bottom Line

The WAL gives BLite its crash recovery guarantee at the cost of an extra write per transaction. The Group Commit pattern distributes that cost across concurrent callers, recovering much of the throughput that naive per-transaction flushing would waste.

The `System.Threading.Channels` machinery — `TaskCompletionSource`, `RunContinuationsAsynchronously`, signal-outside-lock — is a small but precise toolkit for writing correct high-throughput async signaling code. Each piece is there for a specific reason, and removing any of them produces either incorrect behavior or unnecessary serialization.

The complete source is on [GitHub](https://github.com/EntglDb/BLite).
