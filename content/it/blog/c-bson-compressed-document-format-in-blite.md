---
title: "C-BSON: Il Formato Compresso che Ho Costruito in BLite"
description: "Perché ho sostituito i nomi di campo null-terminated di BSON con ID interi a 2 byte, come funziona il sistema di dizionario, e un'analisi onesta dei trade-off."
date: "2026-02-10"
tags: [".net", "blite", "bson", "embedded-database", "performance", "open-source", "storage-engine"]
---

# C-BSON: Il Formato Compresso che Ho Costruito in BLite

Questo è il primo di quella che spero diventi una serie di approfondimenti su BLite — il database embedded a documenti che sto costruendo da zero per .NET. Oggi voglio parlare di una delle decisioni più fondamentali dell'intero progetto: **perché ho smesso di usare il BSON standard e ho costruito un formato personalizzato, che chiamo C-BSON** ("Compressed BSON").

Avviso: questo non sarà un discorso trionfale. Mostrerò codice reale, spiegherò le motivazioni e poi esaminerò criticamente le scelte — perché se stai dedicando del tempo a leggere questo articolo, meriti il quadro completo, non un depliant promozionale.

---

## Il Problema con il BSON Standard

[BSON](https://bsonspec.org/) è il formato wire di MongoDB. È un design ragionevole: una rappresentazione binaria compatta di documenti simili a JSON. Ogni elemento di un documento BSON è serializzato in questo modo:

``` bash
[1 byte: tipo] [N byte: nome campo come UTF-8 null-terminated] [N byte: valore]
```

Il problema è questo: il nome del campo è memorizzato **verbatim in ogni singolo documento**. In ogni documento. In ogni record su disco.

Rendiamolo concreto. Immagina una collezione di profili utente con campi come `email`, `username`, `created_at`, `last_login`, `subscription_tier`. In una collezione di 100.000 documenti, il nome di campo `subscription_tier` (17 byte + null) viene scritto su disco **centomila volte**. Sono 1,8 MB di soli nomi di campo, che non portano alcuna informazione oltre alla prima istanza.

Per i database embedded — dove si ottimizza per ambienti vincolati e i dati hanno uno schema noto e stabile — questo è uno spreco significativo. Lo si paga in:
- **Spazio di archiviazione** (file di database più grandi)
- **Larghezza di banda I/O** (più byte da leggere per documento)
- **Costo di serializzazione** (memcpy dei nomi di campo ad ogni scrittura)

La mitigazione standard nei database a documenti è la compressione (LZ4, Snappy, Zstd). Funziona, ma aggiunge overhead CPU ad ogni lettura/scrittura, e i guadagni sono parziali. Volevo attaccare il problema alla radice.

---

## L'Idea C-BSON: Un Dizionario Condiviso dei Campi

L'intuizione è semplice: se tutti i documenti di una collezione condividono gli stessi nomi di campo, perché non memorizzare i nomi **una volta sola** e riferirsi ad essi tramite un breve ID intero?

C-BSON sostituisce il nome di campo UTF-8 null-terminated con un **ID campo `ushort` a 2 byte**. I nomi dei campi risiedono in un **dizionario a livello di database** — una mappa bidirezionale tra `string` e `ushort` — persistita su disco e caricata in memoria all'avvio.

Il formato wire di ogni elemento diventa:

``` bash
[1 byte: tipo] [2 byte: ID campo come ushort little-endian] [N byte: valore]
```

Si tratta di un **header di elemento fisso a 3 byte**, indipendentemente dalla lunghezza del nome di campo.

Questi i risparmi concreti per un tipico insieme di campi di profili utente:

| Nome campo           | BSON standard (byte) | C-BSON (byte) | Risparmio |
|----------------------|----------------------|---------------|-----------|
| `email`              | 6                    | 2             | 67%       |
| `username`           | 9                    | 2             | 78%       |
| `created_at`         | 11                   | 2             | 82%       |
| `last_login`         | 11                   | 2             | 82%       |
| `subscription_tier`  | 18                   | 2             | 89%       |

Su uno schema di documento realistico, questo riduce la dimensione totale del documento del **30–60%** in base alla verbosità dei nomi di campo rispetto al payload dei valori.

### ID Riservati (0–100)

Gli ID da 0 a 100 sono riservati ai campi di sistema: `_id`, `_v` (versione), `_t` (type discriminator), e altri usati internamente da BLite. I campi utente iniziano dall'ID 101. Questo garantisce la stabilità dello schema: i campi di sistema hanno sempre ID deterministici indipendentemente dall'ordine di inserimento.

---

## Il Sistema di Dizionario

Il dizionario è gestito da `StorageEngine.Dictionary.cs`. Fa tre cose:

1. **Persiste** nomi di campo e i loro ID in una catena di record `DictionaryPage` su disco
2. **Pre-carica** l'intera mappa in memoria all'avvio
3. **Registra nuovi campi** in modo thread-safe quando un campo sconosciuto viene incontrato per la prima volta

Il metodo principale è `GetOrAddDictionaryEntry`:

```csharp
public ushort GetOrAddDictionaryEntry(string key)
{
    key = key.ToLowerInvariant(); // tutti i nomi di campo sono case-insensitive

    // Fast path: colpo nella cache in memoria
    if (_dictionaryCache.TryGetValue(key, out var id)) return id;

    // Slow path: bisogna allocare un nuovo ID e persistirlo
    lock (_dictionaryLock)
    {
        // Double-check dopo aver acquisito il lock
        if (_dictionaryCache.TryGetValue(key, out id)) return id;

        ushort nextId = _nextDictionaryId;

        if (InsertDictionaryEntryGlobal(key, nextId))
        {
            _dictionaryCache[key] = nextId;
            _dictionaryReverseCache[nextId] = key;
            _nextDictionaryId++;
            return nextId;
        }

        throw new InvalidOperationException(
            "Failed to insert dictionary entry (Storage Full?)");
    }
}
```

Alcune cose degne di nota:

**Il double-checked locking** è usato correttamente. Il fast path su `ConcurrentDictionary` evita il lock ad ogni accesso al campo. I nuovi campi sono rari dopo i primi inserimenti, quindi in steady state il codice è sostanzialmente lock-free.

**`ToLowerInvariant()` viene chiamato prima della ricerca in cache.** Questa è una scelta deliberata: tutti i nomi di campo C-BSON vengono normalizzati in minuscolo al momento della registrazione. Significa che `Email`, `EMAIL` e `email` mappano tutti alla stessa voce del dizionario. È comodo — gestisce le inconsistenze da serializzatori diversi — ma ha implicazioni che riesaminerò nella sezione critica.

**`InsertDictionaryEntryGlobal`** scrive il nuovo mapping su disco prima di aggiornare le cache in memoria. Se il processo crasha a metà scrittura, il nuovo ID non entra mai nella cache, e al prossimo avvio viene riletto da disco in uno stato pulito.

All'avvio, BLite pre-registra un insieme di chiavi di sistema per garantire ID stabili:

```csharp
RegisterKeys(new[] { "_id", "t", "_v", "f", "n", "b", "s", "a" });
```

Sono i building block primitivi BSON usati nelle strutture dati interne di BLite.

---

## BsonSpanWriter: Zero Allocazioni sul Percorso di Scrittura

Il serializzatore è `BsonSpanWriter`, un `ref struct` che scrive direttamente su uno `Span<byte>` fornito dal chiamante. Essendo un `ref struct`, può contenere uno `Span<byte>` come campo senza allocazioni sull'heap. L'intera serializzazione di un documento avviene senza toccare il GC.

```csharp
public ref struct BsonSpanWriter
{
    private Span<byte> _buffer;
    private int _position;
    private readonly ConcurrentDictionary<string, ushort> _keyMap;

    public BsonSpanWriter(
        Span<byte> buffer,
        ConcurrentDictionary<string, ushort> keyMap)
    {
        _buffer = buffer;
        _position = 0;
        _keyMap = keyMap;
    }
}
```

Il cuore del formato è `WriteElementHeader`:

```csharp
public void WriteElementHeader(BsonType type, string name)
{
    _buffer[_position] = (byte)type;
    _position++;

    if (!_keyMap.TryGetValue(name, out var id))
        throw new InvalidOperationException(
            $"BSON Key '{name}' not found in dictionary cache. " +
            $"Call GetOrAddDictionaryEntry before serializing.");

    BinaryPrimitives.WriteUInt16LittleEndian(_buffer.Slice(_position, 2), id);
    _position += 2;
}
```

Tre byte scritti. Nessuna scansione per il null terminator, nessuna memcpy della stringa del nome di campo, nessun bounds check oltre lo slice dello span. `BinaryPrimitives.WriteUInt16LittleEndian` è un intrinsic BCL — su x64 compila in una singola istruzione `mov`.

### La Scrittura della Dimensione del Documento in Due Passaggi

I documenti BSON iniziano con la dimensione del documento a 4 byte, che non si conosce finché non si sono scritti tutti gli elementi. C-BSON usa la stessa tecnica in due passaggi del BSON standard:

```csharp
// Fase 1: riserva 4 byte per la dimensione
public int WriteDocumentSizePlaceholder()
{
    var offset = _position;
    _position += 4;
    return offset; // restituisce dove fare il patch dopo
}

// Fase 2: torna indietro e inserisce la dimensione effettiva
public void PatchDocumentSize(int offset)
{
    var size = _position - offset;
    BinaryPrimitives.WriteInt32LittleEndian(_buffer.Slice(offset, 4), size);
}
```

Il chiamante salva l'offset da `WriteDocumentSizePlaceholder`, scrive tutti gli elementi, poi chiama `PatchDocumentSize` con l'offset salvato. Semplice.

---

## BsonSpanReader: Deserializzazione e la Mappa Inversa

Il lettore, `BsonSpanReader`, è la controparte simmetrica — anch'esso un `ref struct` su `ReadOnlySpan<byte>`. Per gli header degli elementi, invece di cercare `string → ushort`, fa il contrario: `ushort → string`.

```csharp
public ref struct BsonSpanReader
{
    private ReadOnlySpan<byte> _buffer;
    private int _position;
    private readonly ConcurrentDictionary<ushort, string> _keys; // mappa inversa
}
```

Lettura di un header di elemento:

```csharp
public (BsonType type, string name) ReadElementHeader()
{
    var type = (BsonType)_buffer[_position++];
    var id = BinaryPrimitives.ReadUInt16LittleEndian(_buffer.Slice(_position, 2));
    _position += 2;

    if (!_keys.TryGetValue(id, out var name))
        throw new InvalidOperationException(
            $"Unknown field ID {id} — dictionary may be out of sync.");

    return (type, name);
}
```

Entrambe le cache — `_keyMap` nel writer e `_keys` nel reader — vengono iniettate al momento della costruzione e condivise con lo storage engine. Non ci sono allocazioni di dizionario per singola chiamata.

### Type Coercion

BLite Studio (il tool GUI di BLite) deve leggere i documenti in maniera schema-less senza conoscere in anticipo i tipi dei campi. Invece di richiedere una corrispondenza esatta del tipo, il reader offre helper di coercizione:

```csharp
public double ReadDoubleCoerced(BsonType bsonType) => bsonType switch
{
    BsonType.Int32 => ReadInt32(),
    BsonType.Int64 => ReadInt64(),
    _ => ReadDouble()
};

public int ReadInt32Coerced(BsonType bsonType) => bsonType switch
{
    BsonType.Int64  => (int)ReadInt64(),
    BsonType.Double => (int)ReadDouble(),
    _ => ReadInt32()
};
```

Esiste anche `ReadInt64Coerced` con lo stesso pattern. Questi helper esistono perché BLite Studio possa visualizzare una colonna come "numero" indipendentemente dal fatto che i singoli documenti abbiano memorizzato il campo come `Int32`, `Int64` o `Double`. È una concessione pragmatica alla realtà del tooling schema-less.

---

## Due Quirk Interessanti da Discutere Apertamente

### 1. Gli Indici degli Array Bypassano il Dizionario

Ecco qualcosa che ho scelto di mantenere dal BSON standard invece di estendere lo schema degli ID di C-BSON: **le chiavi degli elementi degli array usano ancora stringhe ASCII raw**.

In BSON, gli array sono codificati come sotto-documenti dove le chiavi sono le rappresentazioni stringa degli indici: `"0"`, `"1"`, `"2"`, ecc. In C-BSON, queste vengono scritte anch'esse come byte ASCII letterali, non come ID del dizionario.

L'esempio più visibile è in `WriteCoordinates`, il percorso ottimizzato per le coppie di coordinate GIS:

```csharp
// Scrittura dell'elemento array "0" — ASCII raw, non un ID dizionario
_buffer[_position++] = (byte)BsonType.Double;
_buffer[_position++] = 0x30; // ASCII '0'
_buffer[_position++] = 0x00; // null terminator (formato CString standard!)

// Scrittura dell'elemento array "1"
_buffer[_position++] = (byte)BsonType.Double;
_buffer[_position++] = 0x31; // ASCII '1'
_buffer[_position++] = 0x00;
```

Notate: questo è il **formato CString null-terminated**, non l'header C-BSON a 3 byte. Il reader ha un corrispondente metodo `SkipArrayKey()` che salta l'indice di array formattato come CString.

È un problema? Per la maggior parte dei workload, no — gli indici di array sono corti (`"0"` è 2 byte incluso il null, vs 2 byte per un ID del dizionario), quindi non c'è una differenza significativa di dimensione. E per `WriteCoordinates` specificamente, la funzione è iper-ottimizzata per coppie geo `(double, double)`: l'intera implementazione inline evita qualsiasi dispatch dinamico o percorso generico.

Ma **è un'inconsistenza di design.** Il formato ora ha due modalità: ID del dizionario per i campi del documento, CString raw per gli indici degli array. Un parser deve sapere in quale contesto si trova per decodificare correttamente. Considero questo un trade-off accettabile oggi, ma è nella mia lista da rivedere se mai definissi un dizionario completo per gli elementi array (che beneficerebbe le collezioni con pattern profondi di array-di-oggetti).

### 2. Decimal128 Non È Conforme a IEEE 754-2008

Il metodo `WriteDecimal128` memorizza il tipo `decimal` di C# usando la sua rappresentazione bit nativa:

```csharp
public void WriteDecimal128(decimal value)
{
    // Note: usage of C# decimal bits for round-trip fidelity within BLite.
    // This makes it compatible with BLite Reader but strictly speaking
    // not standard IEEE 754-2008 Decimal128.
    var bits = decimal.GetBits(value);
    BinaryPrimitives.WriteInt32LittleEndian(_buffer.Slice(_position, 4), bits[0]);
    BinaryPrimitives.WriteInt32LittleEndian(_buffer.Slice(_position + 4, 4), bits[1]);
    BinaryPrimitives.WriteInt32LittleEndian(_buffer.Slice(_position + 8, 4), bits[2]);
    BinaryPrimitives.WriteInt32LittleEndian(_buffer.Slice(_position + 12, 4), bits[3]);
}
```

`decimal.GetBits()` di C# restituisce quattro valori `int` in un layout specifico del CLR — segno, scala e mantissa a 96 bit — che **non è lo stesso** del formato Decimal128 IEEE 754-2008 a 128 bit usato dal BSON standard, MongoDB e la maggior parte delle altre implementazioni.

Il commento nel codice sorgente è onesto al riguardo: è una scelta deliberata che scambia l'interoperabilità standard per una perfetta fedeltà round-trip all'interno di BLite. Un valore come `1.23456789012345678901234567890m` che sfrutta la precisione a 28 cifre di `.NET decimal` sopravviverà intatto a un round-trip attraverso BLite — ma i byte su disco sono privi di significato per un lettore BSON standard.

**Questo è rilevante** se mai si volessero esportare dati da un database BLite verso un sistema che legge BSON standard: richiederebbe un passaggio di conversione. BLite è un database embedded per applicazioni .NET, non un sostituto drop-in di MongoDB, quindi considero questo trade-off difendibile — ma è giusto che lo sappiate.

### 3. Nomi di Campo Case-Insensitive

La chiamata a `ToLowerInvariant()` in `GetOrAddDictionaryEntry` significa che una volta registrato un campo chiamato `Email`, non esiste un campo separato chiamato `email` — sono la stessa voce. Questo semplifica la vita quando si consumano dati da fonti diverse. Tuttavia:

- Un oggetto con una proprietà `Email` e uno con `email` mapperanno allo stesso ID del dizionario. Se state leggendo documenti scritti con casing diverso da produttori diversi, si risolveranno tutti allo stesso campo. Potrebbe essere quello che volevate — o potrebbe nascondere silenziosamente un bug nel codice produttore.
- `ToLowerInvariant` viene chiamato **ad ogni cache miss**, il che significa che ogni nuova registrazione di campo comporta un'allocazione di stringa. Il costo è ammortizzato sulla vita del database, ma vale la pena notarlo in contesti dove i nomi di campo sono estremamente dinamici.

### 4. Fail-Fast sulle Chiavi Non Registrate

`WriteElementHeader` lancia un'eccezione su una chiave sconosciuta:

```csharp
if (!_keyMap.TryGetValue(name, out var id))
    throw new InvalidOperationException(
        $"BSON Key '{name}' not found in dictionary cache.");
```

Significa che **bisogna** chiamare `GetOrAddDictionaryEntry` prima di chiamare il writer. Nell'utilizzo normale di BLite, il serializzatore generato da source generator gestisce questo automaticamente a compile-time. Ma se si scrive codice di serializzazione personalizzato contro la API di basso livello, è facile ottenere un `InvalidOperationException` a runtime invece di un errore a compile-time.

Un design alternativo sarebbe la registrazione automatica inline della chiave. Ho scelto il fail-fast perché voglio che la registrazione nel dizionario — una scrittura su disco — sia esplicita e verificabile, separata dal hot path di serializzazione. Se questa sia la scelta giusta è discutibile; propendo per "sì" perché le scritture su disco in un hot path di serializzazione sono una trappola.

---

## I Numeri

Benchmark eseguiti su Windows 11, Intel Core i7-13800H, .NET 10.0.4 (Marzo 2026). Metodologia completa in [BENCHMARKS.md](https://github.com/EntglDb/BLite/blob/main/BENCHMARKS.md).

**BLite vs LiteDB**

| Operazione | BLite | LiteDB | ×più veloce |
|---|---|---|---|
| Single insert | 164.6 μs | 820 μs | 5.0× |
| Batch insert (1k docs) | 14.086 μs | 26.760 μs | 1,9× |
| FindById | 3,98 μs | 22,4 μs | 5,6× |
| Full scan (100k docs) | 2.502 μs | 8.500 μs | 3,4× |

**BLite vs SQLite+JSON / DuckDB**

| Operazione | BLite | SQLite+JSON | DuckDB |
|---|---|---|---|
| Single insert | 164.6 μs | 7.400 μs | — |
| FindById | 3,98 μs | 38,2 μs | 11.304 μs |
| Full scan (100k docs) | 2.502 μs | 8.000 μs | — |

Miglioramento delle allocazioni dopo il riuso del buffer WAL (Marzo 2026): batch insert da **64 MB → 31 MB** (−51%).

Serializzazione in isolamento (loop 10k doc): **42% più veloce di `System.Text.Json`**. Documento singolo: **2,4× più veloce**.

Questi numeri sono competitivi, e C-BSON è un contributor determinante. Documenti più piccoli significano meno byte attraverso il serializzatore, meno byte da scrivere nel WAL, meno byte da leggere durante le scansioni.

---

## Critica Onesta: Cosa Non Funziona Ancora

Parliamo delle limitazioni attuali:

**1. Nessun accesso multi-processo.** BLite apre il file di database con `FileShare.None`. La cache del dizionario in memoria è autorevole dopo il caricamento perché nessun altro processo può scrivere su di esso concorrentemente. Va bene per la maggior parte degli scenari embedded, ma esclude casi d'uso come l'esecuzione di BLite in parallelo con un processo di analisi separato. La gestione dell'invalidazione della cache del dizionario diventa non banale una volta che si rimuove questo vincolo.

**2. Il limite dell'ushort.** Gli ID del dizionario sono `ushort`, per un massimo di 65.535 nomi di campo distinti (con 0–100 riservati). Per la maggior parte dei dati strutturati è ampiamente sufficiente. Ma se si memorizzano documenti altamente dinamici — pensate all'event sourcing con chiavi di metadati arbitrarie, o alla telemetria IoT con nomi di sensori variabili — il limite potrebbe essere raggiunto in un deployment abbastanza grande. La correzione è semplice (passare a `uint`), ma è una modifica al formato di storage che rompe la compatibilità.

**3. Il dizionario di schema è globale, non per collezione.** Tutte le collezioni in un database BLite condividono un unico dizionario di campo. Significa che gli ID campo sono stabili tra le collezioni — il che ha il piacevole effetto collaterale che documenti in collezioni diverse possono fare riferimento agli stessi ID senza confusione. Ma significa anche che un campo chiamato `value` nella collezione utenti e uno nella collezione sensori mappano allo stesso ID — corretto, ma leggermente sorprendente.

**4. L'inconsistenza degli indici array** (discussa sopra) significa che i parser del formato devono essere context-aware. È una complessità latente che vorrei eliminare.

---

## Cosa Arriverà per C-BSON

Il documento di specifica (`C-BSON.md` nel repository) elenca alcune estensioni pianificate:

- **Metadati per l'evoluzione dello schema** — `BsonSchema` supporta già il versioning tramite hash fingerprint; il piano è di sfruttare le versioni dello schema per la migrazione automatica lazy in cicli read-modify-write, così i vecchi documenti si aggiornano silenziosamente ai nuovi schemi senza una scansione completa della collezione.
- **Potenziale estensione dello spazio ID** — se il limite dell'ushort si rivelasse problematico, un byte di flag potrebbe segnalare un ID esteso a 4 byte per l'overflow.
- **ID per gli elementi array** — applicare lo stesso approccio del dizionario ai campi di sotto-documenti negli array (non solo ai campi di primo livello del documento).

---

## Il Quadro Completo

C-BSON è una delle decisioni più impattanti nell'architettura di BLite. È la ragione per cui un `FindById` che potrebbe impiegare 10 microsecondi a deserializzare un documento in BSON standard impiega meno di 4 microsecondi in BLite. È anche la ragione per cui i database BLite sono significativamente più piccoli su disco rispetto agli equivalenti LiteDB o SQLite+JSON.

Ma ha trade-off reali:
- Non si può leggere un file C-BSON con un parser BSON standard.
- I valori Decimal128 non sono wire-compatibili con MongoDB o qualsiasi tool che si aspetti IEEE 754-2008.
- L'accesso a processo singolo esclusivo è attualmente un vincolo rigido.
- Il formato privilegia i workload strutturati con schema noto rispetto ai documenti di forma arbitraria.

Erano le scelte giuste? Per il caso d'uso target di BLite — un database embedded ad alte prestazioni per dati strutturati in .NET — penso di sì, per lo più. I trade-off di interoperabilità sono accettabili perché BLite non cerca di essere un sostituto di MongoDB; cerca di essere il database embedded a documenti più veloce per .NET.

Ma lo condivido apertamente perché sono curioso di sapere cosa pensa la community. Ci sono scenari in cui vorreste la compatibilità C-BSON con un formato esterno? Il limite dell'ushort è una preoccupazione reale per voi? La non-conformità del Decimal128 è un blocco?

Il sorgente è su [github.com/EntglDb/BLite](https://github.com/EntglDb/BLite). Tutto il codice citato qui si trova in `src/BLite.Bson/` e `src/BLite.Core/Storage/`. Preferisco sapere dei problemi con queste scelte ora, prima che il formato di storage sia adottato su larga scala, che scoprirlo dopo.

Pull request e issue sono benvenuti.
