---
title: "Storage Multi-File: Come BLite Gestisce l'Accesso Concorrente Server"
date: "2026-04-07"
description: "Come BLite suddivide un database su più file memory-mapped, usa ReaderWriterLockSlim con una strategia fast-path/slow-path per proteggere l'accesso concorrente, e fornisce isolamento a sessione per connessione — e cosa potrebbe andare storto con queste scelte."
tags: [".net", "blite", "concurrency", "storage-engine", "memory-mapped-files", "server", "transactions", "open-source"]
---

Un database embedded che vive in un singolo file va bene per un'app desktop, un tool CLI o un gioco mobile. Un processo, un thread (di solito), un file. Ma nel momento in cui metti un database dietro un server — dove decine di connessioni leggono e scrivono contemporaneamente — il modello a singolo file inizia a scricchiolare.

Questo post riguarda come BLite è passato da "un file, uno scrittore alla volta" a "più file, lettori e scrittori concorrenti, isolamento transazionale per connessione." Coprirò l'architettura, la strategia di locking che lo rende sicuro, il modello a sessioni che dà a ogni connessione il proprio contesto transazionale, e le migrazioni che permettono di convertire tra layout. Poi farò un passo indietro e parlerò di dove queste scelte potrebbero fare male.

---

## Perché Multi-File?

Un database a singolo file ha un unico `MemoryMappedFile` che gestisce tutto l'I/O. Ogni lettura e ogni scrittura — che tocchi un nodo B+Tree dell'indice, una pagina dati o un checkpoint del WAL — passa attraverso lo stesso mapping. Quando il file deve crescere, il mapping a livello OS deve essere disposto e ricreato. Durante quella finestra, nessun lettore può mantenere un riferimento al vecchio mapping o rischia di accedere a memoria liberata.

Il problema si aggrava sotto carico. Una scansione dell'indice blocca un inserimento di documento perché condividono lo stesso file. Un checkpoint scarica ogni pagina sporca attraverso un unico collo di bottiglia. Un `DROP COLLECTION` lascia un buco di frammentazione che può essere recuperato solo riscrivendo l'intero file.

Il layout multi-file di BLite affronta ciascuno di questi problemi:

```
mydb.db            ← file dati principale (pagine, metadati, KV store)
mydb.idx           ← file indice separato (B+Trees, R-Trees, HNSW)
wal/mydb.wal       ← write-ahead log (opzionalmente su un disco diverso)
collections/mydb/
  ├── users.db     ← file dati per-collection
  ├── orders.db
  └── .slots       ← registro slot→nome
```

Le scritture dell'indice non bloccano più le scritture dei dati — vanno su file diversi con lock indipendenti. Eliminare una collection è una cancellazione di file, non una deframmentazione a livello di pagina. Il WAL può vivere su un disco dedicato per I/O sequenziale mentre dati e indici beneficiano delle performance ad accesso casuale degli SSD.

---

## La Configurazione Server

Abilitare il multi-file è una modifica di una riga:

```csharp
var config = PageFileConfig.Server(databasePath);
using var engine = new BLiteEngine(databasePath, config);
```

`Server()` è una factory che deriva tutti i percorsi companion dal percorso del database:

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

All'avvio, il costruttore di `StorageEngine` controlla ogni percorso, crea le directory necessarie e apre un'istanza `PageFile` separata per ogni componente. Se un percorso è `null`, quel componente resta nel file principale — puoi separare solo l'indice, solo il WAL, o tutto quanto.

---

## La Sfida della Concorrenza: Proteggere un MemoryMappedFile

Ecco il problema centrale. Un `MemoryMappedFile` in .NET mappa una regione di un file nello spazio di indirizzi virtuali del processo. Leggere una pagina significa creare un `ViewAccessor` su quel mapping. Ma quando il file deve crescere — ad esempio, viene allocata una nuova pagina oltre la lunghezza corrente del file — il mapping deve essere disposto e ricreato con una capacità maggiore. Se un lettore sta ancora mantenendo un `ViewAccessor` al vecchio mapping mentre lo scrittore lo dispone, il lettore ottiene un `ObjectDisposedException` o, peggio, legge memoria obsoleta.

La soluzione naïve è un mutex: un thread alla volta, lettori e scrittori allo stesso modo. Questo uccide il throughput. La soluzione corretta usa `ReaderWriterLockSlim`:

```csharp
private readonly ReaderWriterLockSlim _rwLock = new(LockRecursionPolicy.NoRecursion);
```

### Fast Path: Read Lock per Accesso Concorrente

La maggior parte delle scritture non richiede crescita del file — il file è già stato pre-allocato in blocchi da 1 MB. Quando il file è abbastanza grande, sia le letture che le scritture acquisiscono solo un **read lock**, che permette concorrenza illimitata:

```csharp
public void WritePage(uint pageId, ReadOnlySpan<byte> source)
{
    // Fast path: file già abbastanza grande — condividi il mapping con i lettori
    if (offset + PageSize <= _fileStream!.Length)
    {
        _rwLock.EnterReadLock();
        try { WritePageCore(pageId, source); }
        finally { _rwLock.ExitReadLock(); }
        return;
    }

    // Slow path: il file deve crescere — lock esclusivo
    _rwLock.EnterWriteLock();
    try
    {
        EnsureCapacityCore(offset);  // Dispone il vecchio MMF, ricrea con nuova dimensione
        WritePageCore(pageId, source);
    }
    finally { _rwLock.ExitWriteLock(); }
}
```

L'intuizione chiave: `ReaderWriterLockSlim` permette un numero qualsiasi di possessori concorrenti del read lock, ma un write lock attende che tutti i lettori rilascino e poi blocca nuove acquisizioni. Quando una scrittura forza la crescita del file, lo scrittore chiama `EnsureCapacityCore()`, che dispone il vecchio `MemoryMappedFile` e ne crea uno nuovo. Durante questo, nessun lettore può mantenere un riferimento al vecchio mapping — il write lock lo garantisce.

### Letture Sotto Read Lock

Il percorso di lettura è più semplice — prende sempre un read lock:

```csharp
public void ReadPage(uint pageId, Span<byte> destination)
{
    _rwLock.EnterReadLock();
    try { ReadPageCore(pageId, destination); }
    finally { _rwLock.ExitReadLock(); }
}
```

Più lettori possono eseguire `ReadPageCore` contemporaneamente. Stanno tutti leggendo dallo stesso `MemoryMappedFile`. Finché nessuno scrittore ha bisogno di far crescere il file, la contesa è zero.

### Perché Non un Semplice Mutex?

Un `Monitor` o un'istruzione `lock` serializza *tutte* le operazioni. Con 50 connessioni client concorrenti, questo significa che 49 lettori aspettano mentre 1 lettore completa, anche se potrebbero tutti operare in parallelo. `ReaderWriterLockSlim` elimina questo collo di bottiglia per i carichi di lavoro a prevalenza di lettura — che è il caso comune per la maggior parte dei database.

### Il Confine Asincrono: SemaphoreSlim

`ReaderWriterLockSlim` ha una limitazione: richiede che il thread acquisente sia anche il thread rilasciante. Questo è incompatibile con `async/await`, dove la continuazione può girare su un thread diverso. Per `FlushAsync()` e `BackupAsync()`, BLite usa un `SemaphoreSlim`:

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

Questo serializza le operazioni di backup e flush senza richiedere affinità di thread. Il trade-off è che `SemaphoreSlim` non distingue lettori da scrittori — ma queste operazioni sono abbastanza infrequenti che il costo è trascurabile.

### Allocazione Sotto Write Lock

L'allocazione delle pagine modifica stato mutabile condiviso — `_nextPageId` e `_firstFreePageId` — quindi ha sempre bisogno di accesso esclusivo:

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

Questo è un punto di contesa — due thread che allocano pagine esattamente nello stesso momento verranno serializzati. Ma l'allocazione è rara rispetto a letture e scritture, quindi l'impatto è proporzionale.

---

## Riepilogo dei Lock

| Operazione | Tipo di Lock | Modalità | Contesa |
|---|---|---|---|
| `ReadPage` | `ReaderWriterLockSlim` | Read | Zero (concorrente con altre letture/scritture) |
| `WritePage` (senza crescita) | `ReaderWriterLockSlim` | Read | Zero (concorrente) |
| `WritePage` (con crescita) | `ReaderWriterLockSlim` | Write | Breve: blocca fino al rilascio di tutti i lettori |
| `AllocatePage` / `FreePage` | `ReaderWriterLockSlim` | Write | Rara: serializzata per file |
| `FlushAsync` / `BackupAsync` | `SemaphoreSlim` | Esclusivo | Infrequente: serializzata |
| `Dispose` | Entrambi | Esclusivo | Una volta: solo allo shutdown |

L'effetto netto: sotto carico normale, letture e scritture sono completamente concorrenti. La contesa avviene solo quando il file deve crescere o una pagina viene allocata — entrambe ammortizzate dalla pre-allocazione in blocchi da 1 MB.

---

## Isolamento a Sessioni: Una Connessione, Una Transazione

Con il livello storage protetto, la domanda successiva è come dare a ogni connessione client un contesto transazionale indipendente. In modalità server, più client si connettono simultaneamente, ciascuno eseguendo le proprie operazioni CRUD. Non dovrebbero vedere le scritture non committate degli altri, e un rollback su una connessione non dovrebbe influenzare le altre.

BLite introduce `BLiteSession`:

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

Il modello:

- **Un `BLiteEngine`** per database, condiviso tra tutte le connessioni.
- **Una `BLiteSession`** per connessione client, creata tramite `engine.OpenSession()`.
- Ogni sessione ha la propria `_currentTransaction` — le scritture non committate vivono nella cache WAL per-transazione, invisibili alle altre sessioni.
- `Commit()` persiste i metadati degli indici, committa la transazione e cancella il riferimento alla transazione della sessione.
- `Dispose()` fa auto-rollback di qualsiasi transazione non committata — se la connessione cade, niente va perso.

```csharp
// Gestore connessione server:
var engine = new BLiteEngine(dbPath, PageFileConfig.Server(dbPath));

var session1 = engine.OpenSession();  // Client 1
var session2 = engine.OpenSession();  // Client 2

session1.BeginTransaction();
session1.GetOrCreateCollection("users").Insert(doc1);

session2.BeginTransaction();
session2.GetOrCreateCollection("users").Insert(doc2);

// doc1 è invisibile a session2, doc2 è invisibile a session1

session1.Commit();  // doc1 ora è visibile alle nuove letture
session2.Rollback(); // doc2 scompare
```

Le collection vengono caricate lazy per sessione e cache con `ConcurrentDictionary<string, Lazy<DynamicCollection>>`. Il `Lazy<T>` con `LazyThreadSafetyMode.ExecutionAndPublication` garantisce che anche se una sessione crea la stessa collection da più thread (ad esempio, handler API paralleli), la `DynamicCollection` viene costruita esattamente una volta.

---

## Migrazione: Da Singolo a Multi e Ritorno

Convertire un database single-file esistente in layout multi-file (o viceversa) avviene tramite `BLiteMigration`:

```csharp
// Single → multi-file
BLiteMigration.ToMultiFile(dbPath, PageFileConfig.Server(dbPath));

// Multi-file → single-file
BLiteMigration.ToSingleFile(dbPath, serverConfig, dbPath);
```

La migrazione:

1. Apre il database sorgente con configurazione single-file.
2. Apre un target temporaneo con configurazione multi-file.
3. Copia tutte le collection (documenti + indici), le entry del KV store e il dizionario C-BSON.
4. Fa checkpoint del target per scaricare tutto sui page file.
5. Sostituisce atomicamente il sorgente: `File.Delete(source)` → `File.Move(temp, source)`.

Se qualcosa fallisce durante la migrazione, il blocco catch cancella il file temporaneo e rilancia l'eccezione. Il database originale resta intatto fino allo swap atomico finale.

La migrazione inversa (`ToSingleFile`) è simmetrica: consolida tutti i file per-collection e l'indice separato in un singolo file `.db`, poi pulisce i componenti multi-file.

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

Un dettaglio sottile: `CopyAll` chiama `target.ImportDictionary(source.GetKeyReverseMap())` prima di copiare i documenti. Il formato C-BSON di BLite comprime i nomi dei campi tramite un dizionario condiviso. Senza sincronizzare il dizionario prima, i byte BSON grezzi nel nuovo file farebbero riferimento a entry del dizionario inesistenti.

---

## Checkpoint e Recovery Attraverso i File

Il WAL è ancora un singolo file, anche in modalità multi-file. Ma le pagine che registra portano page ID codificati — una pagina indice ha il suo marker `0x80000000`, una pagina collection ha `0xC0000000 | slot | localId`. Durante il checkpoint, `GetPageFile()` decodifica ogni page ID e instrada la scrittura al file corretto:

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

Il crash recovery funziona allo stesso modo: all'avvio, l'engine legge il WAL, identifica le transazioni committate e riproduce le loro scritture attraverso la stessa funzione di routing. Poiché i page ID sono auto-descrittivi, il codice di recovery non ha bisogno di un mapping separato di "quali pagine appartengono a quale file" — è codificato nell'ID stesso. (Ho coperto la codifica bit in dettaglio nel [post sul bitwise page routing](/blog/bitwise-page-routing-blite-storage-engine).)

---

## Cosa Potrebbe Andare Storto

Le decisioni di design hanno conseguenze. Ecco quelle a cui penso di più:

### 1. ReaderWriterLockSlim Ha un Problema di Thundering Herd

Quando una chiamata a `WritePage` innesca la crescita del file, ogni lettore in attesa si blocca. Quando il write lock viene rilasciato, tutti corrono a riacquisire il read lock contemporaneamente. Sotto carico pesante con crescite frequenti (ad esempio, bulk insert in un nuovo database), questo crea un effetto thundering herd. La pre-allocazione in blocchi da 1 MB mitiga questo — una volta allocato, il file non avrà bisogno di crescere di nuovo per centinaia di pagine — ma il primo evento di crescita su ogni file collection innesca comunque la valanga.

Un'alternativa sarebbe un array di slot concorrente che i lettori controllano con `Volatile.Read` — nessun lock sull'hot path. Questo è ciò che fa LMDB con la sua tabella lettori. La complessità è maggiore, ma la coda di latenza è più corta.

### 2. I File Per-Collection Moltiplicano i File Descriptor

Ogni collection ottiene il proprio `PageFile`, il che significa il proprio `FileStream` e `MemoryMappedFile`. Un database con 50 collection ha 50 handle di file aperti più il file principale, l'indice e il WAL — 53 in totale. Su Linux con impostazioni `ulimit` predefinite (1024 file descriptor), questo diventa una preoccupazione. Su Windows è meno problematico, ma gli handle sono comunque una risorsa finita.

Il limite di 64 collection (slot a 6 bit) agisce come un tetto naturale, ma è un limite rigido, non configurabile. Se hai bisogno di 65 collection, ti serve un secondo database.

### 3. Il Backup È Inconsistente in Modalità Multi-File

`BackupAsync` attualmente fa checkpoint e copia il file principale. *Non* copia il file indice né i file per-collection. Un backup preso durante un'operazione cattura lo stato del file principale ma lascia gli altri file fuori dallo snapshot. Questa è una limitazione nota: un backup completo richiede di fermare le scritture e copiare tutti i file, o implementare uno snapshot coordinato su tutte le istanze `PageFile`.

### 4. Il Commit Lock È Globale

`_commitLock` serializza tutti i commit e i checkpoint attraverso tutte le sessioni. Due sessioni che committano su collection *diverse* contendono comunque sullo stesso `SemaphoreSlim`. Con il batcher del group commit, questo è meno doloroso — decine di commit possono essere raggruppate in un unico flush WAL — ma il punto di serializzazione resta.

Un percorso di commit per-collection eliminerebbe questa contesa al costo di un formato WAL più complesso. La sequenza attuale — scrivere BEGIN, record dati, COMMIT per ogni transazione in ordine — dovrebbe supportare record interleaved da commit concorrenti. La maggior parte dei database di produzione fa questo (i record WAL portano transaction ID esattamente per questa ragione), ma complica significativamente il recovery.

### 5. Nessun Read Snapshot Tra Sessioni

L'isolamento transazionale di BLite è basato sulla separazione della cache WAL: una sessione vede le sue scritture non committate, più l'ultimo stato committato. Ma non c'è snapshot isolation — se la sessione A legge la pagina X, poi la sessione B committa una modifica alla pagina X, poi la sessione A legge di nuovo la pagina X, vede la nuova versione. Questo è *Read Committed*, non *Repeatable Read* o *Serializable*.

Per molti carichi di lavoro server, Read Committed è sufficiente. Per carichi che necessitano di snapshot consistenti attraverso una lettura multi-step (ad esempio, un report che scansiona migliaia di documenti), questo potrebbe produrre risultati inconsistenti se scritture concorrenti modificano i dati durante la scansione.

---

## In Conclusione

Lo storage multi-file in BLite non riguarda il rendere l'engine più complesso. Riguarda il rimuovere il collo di bottiglia condiviso — un file, un lock, una coda I/O — e sostituirlo con file indipendenti che possono essere letti, scritti, fatti crescere e cancellati indipendentemente.

La strategia fast-path di `ReaderWriterLockSlim` rende letture e scritture concorrenti sotto carico normale. `BLiteSession` dà a ogni connessione il proprio ambito transazionale. `BLiteMigration` permette di passare tra layout senza riscrivere il codice applicativo. E i page ID bit-tagged legano tutto insieme con un routing a zero allocazioni che sopravvive a restart e crash.

Le limitazioni sono reali — consistenza del backup, serializzazione globale dei commit, semantica Read Committed — ma sono il tipo di trade-off che fai consciamente quando vuoi mantenere un database embedded abbastanza semplice da contenerlo nella testa.

Il codice sorgente completo è su [GitHub](https://github.com/nicholasosaka/BLite).
