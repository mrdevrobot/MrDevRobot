---
title: "MVCC Lite: Come BLite Ti Dà le Transazioni Senza un Engine di Concorrenza Completo"
date: "2026-03-31"
description: "Come BLite implementa l'isolamento delle transazioni usando due dizionari in memoria — un WAL cache per le scritture uncommitted e un WAL index per le pagine committed-ma-non-ancora-checkpointed — e dove questo approccio si discosta dal vero MVCC."
tags: [".net", "blite", "mvcc", "transactions", "concurrency", "acid", "open-source", "internals"]
---

Ogni database serio fa la stessa promessa: una transazione o viene completata interamente oppure non avviene affatto. Leggere dati a metà transazione ti dà uno snapshot coerente, non un miscuglio di dati scritti a metà. E se il processo crasha, non perdi i dati committed.

Mantenere quelle promesse mentre si consentono lettori e scrittori concorrenti è la parte difficile. La maggior parte dei database in produzione usa il Multi-Version Concurrency Control — MVCC — per farlo. BLite usa un modello più semplice che ottiene la maggior parte delle garanzie con una frazione della complessità. Ecco esattamente come funziona e dove sono le crepe.

---

## Il Problema che MVCC Risolve

Senza nessun controllo della concorrenza, due transazioni che leggono e scrivono le stesse pagine simultaneamente producono il caos: una transazione legge una pagina che un'altra sta scrivendo a metà. La soluzione è dare a ogni transazione la propria *vista* dei dati — uno snapshot preso al momento in cui la transazione è iniziata, immune a modifiche concorrenti.

Il vero MVCC (come in PostgreSQL) lo fa con catene di versioni: ogni riga aggiornata mantiene la sua vecchia versione su disco accanto a quella nuova, etichettata con gli ID delle transazioni. I lettori scelgono la versione il cui timestamp è ≤ al loro tempo di inizio transazione. Gli scrittori non bloccano mai i lettori.

Questo è potente e generale. È anche complesso: processi di vacuum, tuple header, wraparound degli ID di transazione, visibility map. BLite adotta un approccio diverso.

---

## Due Dizionari, Un Contratto

L'isolamento delle transazioni in BLite è costruito su due strutture dati in memoria:

```csharp
// Scritture uncommitted per transazione
private readonly ConcurrentDictionary<ulong, ConcurrentDictionary<uint, byte[]>> _walCache = new();

// Pagine committed-ma-non-ancora-checkpointed (il "ring stabile")
private readonly ConcurrentDictionary<uint, byte[]> _walIndex = new();
```

`_walCache` è un dizionario di dizionari: la chiave esterna è l'ID della transazione (`ulong`), la chiave interna è il page ID (`uint`), e il valore è l'array di byte della pagina. Ogni scrittura va nella cache privata del chiamante, invisibile agli altri.

`_walIndex` è un dizionario piatto: page ID → byte array corrente. Rappresenta lo stato committed di tutte le pagine scritte dall'ultimo checkpoint. Quando si legge una pagina, si controlla prima `_walIndex` per la versione committed.

Il percorso di lettura combina entrambi:

```csharp
public byte[] ReadPage(uint pageId, ulong transactionId)
{
    // Prima: verifica se questa transazione ha scritto la pagina (leggi le tue scritture)
    if (_walCache.TryGetValue(transactionId, out var txnCache) &&
        txnCache.TryGetValue(pageId, out var uncommitted))
        return uncommitted;

    // Seconda: verifica se esiste una versione committed dall'ultimo checkpoint
    if (_walIndex.TryGetValue(pageId, out var committed))
        return committed;

    // Terza: leggi dal file di pagine durabilmente persistito
    return _pageFile.ReadPage(pageId);
}
```

Una transazione legge sempre le proprie scritture uncommitted. Se non ha toccato una pagina, legge da `_walIndex` — lo stato committed delle transazioni precedenti (committed). Se `_walIndex` non ha nemmeno la pagina, cade sul file di pagine durevole.

---

## Ciclo di Vita di una Transazione

**Begin:** Alloca semplicemente un nuovo ID di transazione. Nient'altro ancora.

```csharp
public ulong BeginTransaction()
{
    ulong txnId = Interlocked.Increment(ref _transactionCounter);
    _walCache[txnId] = new ConcurrentDictionary<uint, byte[]>();
    return txnId;
}
```

**Write:** Bufferizza la pagina modificata nella cache privata della transazione.

```csharp
public void WritePage(uint pageId, byte[] data, ulong transactionId)
{
    if (!_walCache.TryGetValue(transactionId, out var txnCache))
        throw new InvalidOperationException("Nessuna transazione attiva");

    // Copia per permettere al chiamante di riutilizzare il suo buffer
    var copy = new byte[data.Length];
    data.CopyTo(copy, 0);
    txnCache[pageId] = copy;
}
```

**Commit:** Consegna le pagine dirty della transazione alla pipeline del group commit, che le raggruppa nel WAL, le flushta su disco, le sposta in `_walIndex` e completa il `TaskCompletionSource` che il chiamante sta aspettando.

```csharp
public async Task CommitTransactionAsync(ulong transactionId)
{
    if (!_walCache.TryRemove(transactionId, out var txnCache))
        throw new InvalidOperationException("Nessuna transazione attiva");

    var pending = new PendingCommit(transactionId, txnCache, new TaskCompletionSource(
        TaskCreationOptions.RunContinuationsAsynchronously));

    await _commitChannel.Writer.WriteAsync(pending);
    await pending.Completion.Task; // Aspetta che il group commit finisca
}
```

**Abort:** Rimuovi semplicemente la voce della transazione da `_walCache`. Le pagine dirty sono sparite. Nessun I/O.

```csharp
public void AbortTransaction(ulong transactionId)
{
    _walCache.TryRemove(transactionId, out _);
}
```

Il rollback gratuito è un autentico vantaggio del design WAL cache. Non c'è nessun "undo log" da rieseguire, nessun ripristino di pagina da scrivere. I dati uncommitted non erano mai stati visibili a nessun altro e semplicemente cessano di esistere.

---

## Group Commit: Da `_walCache` a `_walIndex`

Il loop del group commit gira su un background task dedicato:

```csharp
private async Task GroupCommitLoopAsync(CancellationToken ct)
{
    await foreach (var pending in _commitChannel.Reader.ReadAllAsync(ct))
    {
        var batch = new List<PendingCommit> { pending };

        // Drena eventuali commit aggiuntivi arrivati mentre eravamo in elaborazione
        while (_commitChannel.Reader.TryRead(out var extra))
            batch.Add(extra);

        // Scrivi tutte le pagine in batch nel WAL stream (singolo fsync)
        await using var walLock = await _walLock.LockAsync();

        foreach (var commit in batch)
        {
            WriteCommitToWalStream(commit);
            // Sposta le pagine committed nell'indice stabile
            foreach (var (pageId, data) in commit.Pages)
                _walIndex[pageId] = data;
        }

        await _walStream.FlushAsync();

        // Segnala tutti i waiter *fuori* dal lock
        foreach (var commit in batch)
            commit.Completion.TrySetResult();
    }
}
```

Tutte le transazioni nel batch condividono una singola chiamata `FlushAsync`. Questo è il dividendo del group commit: invece di un fsync per commit (un'operazione disco di ~10ms), N transazioni condividono un fsync a ~10ms totali. Ad alti tassi di commit, questa è la differenza tra 100 commit/sec e 10.000 commit/sec.

---

## Perché `SemaphoreSlim` sul WAL Stream

Il WAL stream è stato condiviso. Qualsiasi iterazione concorrente del loop di commit lo corromperebbe. BLite usa un async lock basato su `SemaphoreSlim`:

```csharp
private readonly SemaphoreSlim _walLock = new(1, 1);

// Wrapper comodo che rilascia il semaforo all'uscita
private async Task<IDisposable> LockAsync()
{
    await _walLock.WaitAsync();
    return new SemaphoreReleaser(_walLock);
}
```

`SemaphoreSlim` con contatore iniziale 1 è il mutex async idiomatico in .NET. A differenza di `lock`, non blocca un thread mentre aspetta — cede il controllo al thread pool, il che conta quando il lock è tenuto durante `FlushAsync` (un'operazione async che causerebbe un deadlock con un lock sincrono).

---

## Checkpoint: Collassare il WAL nel Page File

Man mano che le transazioni vengono committate, `_walIndex` cresce. Alla fine diventa abbastanza grande da rendere inaccettabile il tempo di avvio (riapplicazione del WAL) durante il recovery. Un checkpoint unisce il `_walIndex` nel file di pagine durevole e tronca il WAL:

```csharp
private async Task CheckpointInternalAsync(CancellationToken ct)
{
    await using var walLock = await _walLock.LockAsync();

    // Scrivi tutte le pagine stabili nel page file
    foreach (var (pageId, data) in _walIndex)
        await _pageFile.WritePageAsync(pageId, data, ct);

    await _pageFile.FlushAsync(ct);

    // Ora è sicuro troncare il WAL
    _walStream.SetLength(0);
    _walStream.Seek(0, SeekOrigin.Begin);
    _walIndex.Clear();
}
```

Il checkpointing è serializzato sotto `_walLock`, il che significa che blocca il loop del group commit. Durante un checkpoint, le chiamate di commit in arrivo si accodano in `_commitChannel` e riprendono una volta rilasciato il lock. La durata del lock è proporzionale al numero di pagine dirty — un altro argomento per checkpoint piccoli e frequenti rispetto a quelli rari e grandi.

---

## Dove Questo Si Discosta dal Vero MVCC

Il modello di BLite ti dà le proprietà ACID che contano per un database embedded:

- **Atomicità**: le pagine uncommitted sono invisibili; il rollback è gratuito.
- **Consistenza**: i vincoli sono applicati al livello del documento prima che le pagine vengano scritte.
- **Isolamento**: ogni transazione legge una vista coerente — le proprie scritture sovrapposte allo stato dell'ultimo committed.
- **Durabilità**: le transazioni committed sopravvivono a un crash perché sono nel WAL prima che `TrySetResult` scatti.

Ma non è MVCC completo nel senso della teoria dei database:

**Nessun snapshot isolation.** Due lettori concorrenti non vedono ciascuno lo stato del database ai loro singoli tempi di inizio. Entrambi leggono dallo stesso snapshot `_walIndex` — lo stato dell'ultima transazione committata. Se la transazione A legge la pagina 5, poi la transazione B committe un aggiornamento alla pagina 5, poi la transazione A legge di nuovo la pagina 5, vedrà l'aggiornamento committato di B. Questo è l'isolamento "read committed", non "repeatable read" o "serializable."

**Singolo scrittore logico.** I commit sono serializzati attraverso `_commitChannel`. Le transazioni concorrenti possono preparare le loro pagine dirty in parallelo (ciascuna nella propria voce `_walCache`) ma solo un commit alla volta passa attraverso il loop del group commit. Non c'è percorso di scrittura concorrente — il "group" nel group commit significa raggruppamento, non parallelismo.

**I lettori possono stallare durante il checkpoint.** Il loop di checkpoint tiene `_walLock`, che serializza rispetto al loop di commit, che serializza rispetto a tutti i nuovi commit. Un checkpoint lungo può ritardare tutti i nuovi commit per la sua durata. Un sistema MVCC appropriato permetterebbe ai lettori di procedere contro le vecchie versioni mentre il checkpoint scrive quelle nuove.

---

## Il Verdetto

Per un database di documenti embedded a singolo scrittore, il design a due dizionari di BLite è un punto di compromesso pragmatico. Il rollback è una rimozione da dizionario. Le letture vedono sempre uno stato committed coerente. Il group commit ammortizza la latenza del disco attraverso le transazioni concorrenti. E l'implementazione è abbastanza piccola da leggere in un pomeriggio.

I limiti — isolamento read committed, scrittori serializzati, checkpoint bloccante — sono reali. Ma per il caso d'uso di gran lunga più comune, "un processo, accesso sequenziale o leggermente concorrente," in pratica non contano.

Il sorgente completo è su [GitHub](https://github.com/EntglDb/BLite).
