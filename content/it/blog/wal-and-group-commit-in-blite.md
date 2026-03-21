---
title: "Write-Ahead Log e Group Commit: Durabilità Senza Sacrificare il Throughput"
date: "2026-03-03"
description: "Come BLite usa un Write-Ahead Log per garantire la durabilità, e il pattern Group Commit — basato su System.Threading.Channels e TaskCompletionSource — che ammortizza il costo di fsync tra transazioni concorrenti."
tags: [".net", "blite", "wal", "transactions", "channels", "durability", "performance", "open-source"]
---

La durabilità è la D di ACID. Significa che una volta che una transazione fa commit, i suoi effetti sopravvivono a un crash, un'interruzione di corrente, o un panic del sistema operativo. Significa anche che ogni commit deve, a un certo punto, forzare i dati sulla memoria stabile — e quell'operazione è lenta.

Questo post parla dei due componenti di BLite che gestiscono la durabilità: il **Write-Ahead Log** che registra le modifiche prima che vengano applicate al page file, e il meccanismo di **Group Commit** che impedisce al costo di `fsync` di diventare un collo di bottiglia del throughput.

---

## Il Problema Fondamentale

Un page file di database non è una struttura append-only. Le scritture lo aggiornano sul posto — inserisci un record in una pagina, aggiorna un campo, dividi un nodo del B-Tree. Se il processo crasha a metà operazione, il page file può rimanere in uno stato parzialmente scritto e inconsistente.

La soluzione classica è un **Write-Ahead Log**: prima di toccare il page file, scrivi un record su un log append-only che descrive *quello che stai per fare*. Se il processo crasha, il log sopravvive (append-only significa nessuna sovrascrittura parziale). Al riavvio, riproduci i record committati per riportare il page file allo stato corretto, e scarta quelli non committati.

Il compromesso è che ogni commit richiede che il log venga svuotato su disco. Sull'hardware tipico, un flush (`fsync` o `FlushFileBuffers`) costa tra 5 e 30 microsecondi su un SSD, e 50–200 microsecondi su un disco rotante. Quel tetto diventa il tetto della tua frequenza di transazioni.

---

## Formato dei Record WAL

Il WAL di BLite usa cinque tipi di record:

```csharp
public enum WalRecordType : byte
{
    Begin      = 1,   // 17 byte: type(1) + txnId(8) + timestamp(8)
    Write      = 2,   // variabile: type(1) + txnId(8) + pageId(4) + pageData(N)
    Commit     = 3,   // 17 byte
    Abort      = 4,   // 17 byte
    Checkpoint = 5    // 17 byte
}
```

I record a dimensione fissa (Begin, Commit, Abort, Checkpoint) sono sempre 17 byte. I record Write sono variabili perché portano l'intero contenuto di una pagina. Questo rende la scansione per crash-recovery semplice: leggi il byte del tipo, scegli il ramo, e sai esattamente quanti byte consumare.

---

## Due Strategie di Allocazione: `stackalloc` e `ArrayPool`

Scrivere un record Begin richiede un buffer da 17 byte. Nel path sincrono, quel buffer vive sullo stack:

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

`stackalloc byte[17]` alloca sullo stack del thread, non sull'heap. Nessuna pressione sul GC — solo 17 byte che spariscono quando il metodo ritorna.

Il path asincrono non può usare `stackalloc` perché il compilatore C# deve sollevare le variabili locali in una struct state machine per i punti di sospensione `await`, e `Span<T>` non può essere un campo di una classe o struct sull'heap. La soluzione è `ArrayPool`:

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

`ArrayPool<T>.Shared.Rent(17)` restituisce un `byte[]` pooled di almeno 17 byte. Il `Return` nel blocco `finally` lo rimette nel pool — la chiamata successiva riusa lo stesso array. Su un loop di transazioni intenso, questo significa praticamente zero allocazioni heap per la scrittura dei record WAL.

Il pattern — `stackalloc` nei path sincroni, `ArrayPool` nei path asincroni — appare in tutto il codice performance-sensitive di BLite.

---

## Il Pattern Group Commit

Le chiamate `fsync` individuali sono il collo di bottiglia. L'intuizione dietro il group commit è che se dieci transazioni committano tutte entro pochi microsecondi l'una dall'altra, non servono dieci flush — ne basta uno. Tutte e dieci possono condividere la garanzia di durabilità di un singolo flush, purché tutti i loro record WAL siano presenti prima del flush.

BLite implementa questo con un loop di scrittura in background e `System.Threading.Channels`:

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

Quando una transazione committa, posta un `PendingCommit` nel channel e aspetta il suo task `Completion`:

```csharp
public async Task CommitTransactionAsync(ulong transactionId, CancellationToken ct = default)
{
    _walCache.TryGetValue(transactionId, out var pages);
    var pending = new PendingCommit(transactionId, pages);
    await _commitChannel.Writer.WriteAsync(pending, ct).ConfigureAwait(false);
    await pending.Completion.Task.ConfigureAwait(false);
}
```

Il loop del writer in background — in esecuzione su un thread dedicato — svuota il channel:

```csharp
private async Task GroupCommitWriterAsync(CancellationToken ct)
{
    var batch = new List<PendingCommit>(32);

    while (true)
    {
        batch.Clear();

        // Blocca finché almeno un commit arriva
        var first = await _commitChannel.Reader.ReadAsync(ct).ConfigureAwait(false);
        batch.Add(first);

        // Svuota gli altri commit già in coda — nessun costo I/O extra
        while (batch.Count < 64 && _commitChannel.Reader.TryRead(out var next))
            batch.Add(next);

        await ProcessBatchAsync(batch).ConfigureAwait(false);
    }
}
```

`TryRead` è non-bloccante. Se nel channel non c'è altro, il batch parte immediatamente. Se dieci transazioni sono arrivate mentre il batch precedente eseguiva il flush, vengono tutte raccolte nel prossimo loop `TryRead` e condividono un singolo flush.

---

## Elaborazione del Batch

Il flush stesso scrive tutti i record dell'intero batch nel WAL stream, emette un solo `FlushAsync`, poi promuove le pagine nel WAL index (rendendole visibili ai lettori):

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

        // UN SOLO flush per l'intero batch
        await _wal.FlushAsync().ConfigureAwait(false);

        // Promuovi al WAL index — ora visibili ai lettori
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
    catch (Exception ex) { failure = ex; }
    finally { _commitLock.Release(); }

    // Segnala tutti i waiter — FUORI dal lock
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

## Perché `RunContinuationsAsynchronously` È Importante

Senza `RunContinuationsAsynchronously`, chiamare `TrySetResult(true)` su un `TaskCompletionSource` esegue la continuazione *in modo sincrono sul thread corrente* — il thread del group commit writer. Ogni transazione in attesa su `await pending.Completion.Task` riprenderebbe inline, una dopo l'altra, prima che `TrySetResult` ritorni. Il thread writer sarebbe bloccato a fare il lavoro della tua applicazione mentre il prossimo batch siede nel channel.

Con `RunContinuationsAsynchronously`, le continuazioni vengono postate nel thread pool e girano in modo concorrente. Il thread writer finisce di segnalare tutte le completion immediatamente e torna a svuotare il prossimo batch.

---

## Segnalare Fuori dal Lock

Il loop che chiama `TrySetResult` avviene *dopo* `_commitLock.Release()`. È deliberato.

Se tenessi il lock durante la segnalazione, e una continuazione tentasse di acquisire lo stesso lock (per esempio, se iniziasse immediatamente a scrivere un'altra transazione), andresti in deadlock — o nel migliore dei casi serializzeresti lavoro che dovrebbe essere parallelo. Rilasciare il lock prima di segnalare garantisce che quando qualsiasi continuazione viene eseguita, il lock sia già libero.

Il pattern "segnala fuori dal lock" è un classico nella programmazione concorrente. È facile sbagliarlo se si fa refactoring del codice senza capire perché il segnale è dove si trova.

---

## Il Sentinel di Flush

Le app MAUI si sospendono in background mentre tengono connessioni database aperte. BLite espone un metodo per garantire che tutto ciò che è in sospeso sia durevole prima della sospensione:

```csharp
public async Task FlushPendingCommitsAsync(CancellationToken ct = default)
{
    var sentinel = new PendingCommit(0, null);
    await _commitChannel.Writer.WriteAsync(sentinel, ct).ConfigureAwait(false);
    await sentinel.Completion.Task.ConfigureAwait(false);
}
```

Il sentinel ha `TransactionId = 0` e nessuna pagina. Quando il loop writer lo elabora, il path del record commit è un no-op, ma il flush avviene comunque e la `Completion` del sentinel viene impostata. Il chiamante sa che quando `FlushPendingCommitsAsync` ritorna, ogni commit che era nel channel al momento della chiamata è su memoria stabile.

---

## Checkpoint

Man mano che le transazioni si accumulano, il WAL cresce. BLite fa checkpoint automaticamente quando il WAL supera `MaxWalSize`: copia tutte le pagine dal WAL index nel page file principale, poi tronca il WAL.

Questa è la parte più debole del design attuale. Il checkpoint è un'operazione stop-the-world — nessuna lettura o scrittura può avvenire durante di esso. Per database embedded piccoli con workload prevedibili, è accettabile. Per qualcosa che assomiglia a un workload server, servirebbe un checkpoint fuzzy o online (come PostgreSQL ha dall'8.0).

---

## Conclusione

Il WAL dà a BLite la sua garanzia di crash recovery al costo di una scrittura extra per transazione. Il pattern Group Commit distribuisce quel costo tra i chiamanti concorrenti, recuperando gran parte del throughput che il flush per-transazione naïve spreherebbe.

La macchina `System.Threading.Channels` — `TaskCompletionSource`, `RunContinuationsAsynchronously`, segnala-fuori-dal-lock — è un toolkit piccolo ma preciso per scrivere codice di segnalazione asincrona ad alto throughput e corretto. Ogni pezzo è lì per un motivo specifico, e rimuovere uno qualsiasi produce comportamento incorretto o serializzazione non necessaria.

Il codice completo è su [GitHub](https://github.com/EntglDb/BLite).
