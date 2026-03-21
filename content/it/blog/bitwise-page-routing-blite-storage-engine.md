---
title: "Quattro File o Uno: Il Routing Bitwise delle Pagine in BLite"
date: "2026-03-24"
description: "Come BLite codifica il tipo di file, lo slot di collection e il numero di pagina locale in un singolo uint — e perché questo page ID auto-descrittivo permette allo storage engine di instradare letture e scritture su più file memory-mapped con una bitmask e senza lookup di schema."
tags: [".net", "blite", "storage-engine", "memory-mapped-files", "bitwise", "performance", "open-source"]
---

La maggior parte dei database embedded usa un singolo file. Semplice, affidabile, facile da ragionare. Ma BLite supporta quattro modalità di deployment — da un singolo file unificato a file per-collection a una separazione client/server — e il codice che le gestisce è sorprendentemente piccolo. Il trucco è codificare le informazioni di routing direttamente nel page ID.

---

## Il Problema di Deployment

Un database embedded ha requisiti in competizione. Un piccolo tool CLI vuole un singolo file `.db` che può copiare ed eliminare. Un'applicazione multi-tenant vuole che le collection vivano in file separati per poterle fare il backup o migrare indipendentemente. Un processo server vuole l'indice nel suo file, separato dai dati, per pattern di accesso I/O diversi.

BLite risolve questo con quattro configurazioni nominate:

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

In modalità `Embedded`, tutto — dati, indici, metadati — vive in un file. In `SeparateIndex`, l'indice ottiene il suo file. In `PerCollection`, ogni collection ottiene il suo file. In `Server`, lo storage engine agisce come un file store remoto gestito da un processo server.

La sfida: il codice che scrive o legge una pagina non dovrebbe dover sapere in quale modalità si trova. Dovrebbe semplicemente chiamare `ReadPage(pageId)` e ottenere i byte giusti, indipendentemente da quanti file contengono i dati.

---

## Il Page ID Auto-Descrittivo

BLite codifica il tipo di file, lo slot di collection e il numero di pagina locale in un singolo `uint`:

```
Bit 31: index page marker      (1 = file indice)
Bit 30: collection page marker (1 combinato con bit 31 = 11)
Bit 29-24: collection slot     (6 bit → fino a 64 collection)
Bit 23-0:  local page number   (24 bit → fino a 16.777.215 pagine per file)
```

I due bit alti definiscono il tipo di file:

```csharp
private const uint IndexPageMarker      = 0x8000_0000u; // bit 31: 10xx xxxx ...
private const uint CollectionPageMarker = 0xC000_0000u; // bit 31-30: 11xx xxxx ...
private const uint CollectionSlotMask   = 0x3F00_0000u; // bit 29-24
private const uint LocalPageMask        = 0x00FF_FFFFu; // bit 23-0
private const uint IndexLocalMask       = 0x7FFF_FFFFu; // bit 30-0 (per file indice)
```

Quando la modalità `Embedded` usa solo il file principale, i page ID sembrano interi sequenziali normali: `1`, `2`, `3`, …. Nessun bit è impostato nelle posizioni alte. Quando lo storage engine alloca una pagina dell'indice, vi fa OR con il marker:

```csharp
public uint AllocateIndexPage(ITransaction? transaction = null)
{
    uint localId = _indexFile.AllocatePage(transaction);
    return IndexPageMarker | (localId & IndexLocalMask);
}
```

Quando alloca una pagina di collection, codifica anche lo slot a 6 bit:

```csharp
public uint AllocateCollectionPage(string collectionName, ITransaction? transaction = null)
{
    int slot = GetOrAssignCollectionSlot(collectionName);
    uint localId = _collectionFiles[slot].AllocatePage(transaction);
    uint slotBits = (uint)(slot & 0x3F) << 24;
    return CollectionPageMarker | slotBits | (localId & LocalPageMask);
}
```

Il risultato: ogni `uint` page ID è auto-descrittivo. Puoi guardare un page ID e sapere immediatamente a quale file appartiene, in quale collection si trova, e qual è il suo offset locale — senza nessun lookup di schema o dizionario.

---

## Il Router: `GetPageFile`

Tutte le letture e scritture passano attraverso una singola funzione di routing:

```csharp
private IPageFile GetPageFile(uint pageId, out uint physicalPageId)
{
    if ((pageId & CollectionPageMarker) == CollectionPageMarker)
    {
        // Bit 31-30 = 11 → file di collection
        int slot = (int)((pageId & CollectionSlotMask) >> 24);
        physicalPageId = pageId & LocalPageMask;
        return _collectionFiles[slot];
    }
    else if ((pageId & IndexPageMarker) == IndexPageMarker)
    {
        // Bit 31 = 1, bit 30 = 0 → file indice
        physicalPageId = pageId & IndexLocalMask;
        return _indexFile;
    }
    else
    {
        // Nessun bit alto impostato → file di pagine principale
        physicalPageId = pageId;
        return _mainFile;
    }
}
```

Nota l'ordinamento: `CollectionPageMarker` (`0xC000_0000`) viene testato prima di `IndexPageMarker` (`0x8000_0000`) perché le pagine di collection hanno *entrambi* i bit impostati. Testare prima `IndexPageMarker` farebbe corrispondere erroneamente le pagine di collection.

Il chiamante ottiene il `IPageFile` corretto e il numero di pagina fisico (decodificato). Il routing è due confronti e due operazioni di bitmask — essenzialmente gratuito a runtime.

---

## Crescita del File: `AlignToBlock`

Il re-sizing dei file è costoso. Ogni volta che si estende un file, l'OS deve aggiornare i metadati, potenzialmente riempire di zero le nuove pagine e può scatenare un flush. Crescere una pagina alla volta è impraticabile.

BLite fa crescere i file in blocchi allineati:

```csharp
private static long AlignToBlock(long requiredLength, long blockSize = 1_048_576 /* 1 MB */)
{
    if (requiredLength <= 0) return blockSize;
    long remainder = requiredLength % blockSize;
    return remainder == 0 ? requiredLength : requiredLength + (blockSize - remainder);
}
```

Quando lo storage engine ha bisogno di una nuova pagina e il file non è abbastanza grande, arrotonda la lunghezza richiesta al prossimo limite di 1 MB e ridimensiona in un colpo solo. Le nuove pagine nel gap vengono inizializzate con un marker "pagina vuota" riservato. Questo riduce la frequenza delle operazioni di resize a livello OS di circa tre ordini di grandezza per workload tipici.

---

## File Memory-Mapped in .NET

BLite usa `MemoryMappedFile` per tutti gli I/O di pagina:

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

I file memory-mapped permettono al kernel dell'OS di gestire la page cache. Leggere una pagina non richiede una syscall `Read` — la pagina si mappa direttamente nello spazio degli indirizzi virtuali del processo e viene portata dal disco su richiesta al primo accesso. Anche il write-back è gestito dall'OS: le pagine modificate vengono flushate su disco quando l'OS lo decide, o esplicitamente via `_accessor.Flush()`.

Questo dà a BLite letture zero-copy e l'intero vantaggio dello scheduling I/O a livello OS. Il trade-off: non puoi controllare facilmente *quando* le pagine dirty vengono flushate, ed è per questo che esiste il WAL — la durabilità è garantita dal log, non dal file memory-mapped.

---

## Configurazione Immutabile: `record struct` con `with`

La configurazione dei file di pagina è rappresentata come `record struct` — semantica a valore, immutabile per convenzione, copia-alla-modifica via `with`:

```csharp
public readonly record struct Config
{
    public Mode DeploymentMode { get; init; }
    public string DatabasePath { get; init; }
    public string? MapName { get; init; }

    // Esempio: crea una config server con un map name personalizzato
    public Config WithMapName(string mapName) => this with { MapName = mapName };
}
```

`record struct` è una feature di C# 10. Genera `Equals`, `GetHashCode` e `ToString` basati sui campi, e l'espressione `with` crea una copia con un campo cambiato senza mutare l'originale. Questo è utile per il setup dei test: parti da `PageFileConfig.Embedded(path)` e deriva varianti per scenari di test specifici senza stato mutabile condiviso.

---

## I Limiti Concreti

La codifica impone limiti rigidi che vale la pena conoscere prima di impegnarsi con BLite:

| Risorsa | Limite | Perché |
|---|---|---|
| Collection per database | 64 | Slot a 6 bit nei bit 29–24 |
| Pagine per file di collection | 16.777.215 | Local page number a 24 bit |
| Pagine per file indice | 536.870.911 | Local page number a 30 bit (il bit 31 è occupato) |
| Pagine per file principale | 536.870.911 | Idem, nessun bit alto consumato |

A 4 KB per pagina, un singolo file di collection può contenere fino a 64 GB di dati. Superare quel limite richiede una migrazione dello schema per dividere la collection su più database, cosa che BLite non automatizza ancora.

---

## Cosa Farei Diversamente

Il limite di 64 collection è il punto dolente più probabile in pratica. Un campo slot a 7 bit (128 collection) cambierebbe la codifica ma tutti i database esistenti sarebbero incompatibili — una migrazione dello schema è inevitabile in ogni caso. Farlo prima è la scelta giusta.

La crescita per file alloca 1 MB alla volta, il che è ragionevole per collection grandi ma spreca spazio per database con molte collection piccole. Una dimensione del blocco configurabile per file aiuterebbe, al costo di più complessità in `AlignToBlock`.

La modalità server è attualmente uno stub — il codice di routing esiste ma il trasporto I/O remoto non c'è. Se usi BLite oggi, `Embedded` e `SeparateIndex` sono le uniche modalità pronte per la produzione.

---

## Il Verdetto

Codificare tipo di file, slot di collection e numero di pagina locale in un `uint` è una di quelle idee che sembra brillante finché non realizzi che sono solo due controlli di bitmask e alcuni bit-shift. Il risultato è un layer di routing senza allocazioni heap, senza lookup su dizionario, e dispatch O(1) da qualsiasi page ID al file fisico corretto.

Il sorgente completo è su [GitHub](https://github.com/EntglDb/BLite).
