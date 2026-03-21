---
title: "Un B+Tree Page-Based da Zero: Come BLite Indicizza i Dati"
date: "2026-03-10"
description: "Una panoramica sull'implementazione del B+Tree in BLite: nodi allineati alle pagine, header come struct, splitting dei nodi con ArrayPool, range scan su foglie doubly-linked, e il trucco stackalloc nel path di lettura."
tags: [".net", "blite", "btree", "indexing", "performance", "storage-engine", "open-source", "internals"]
---

Ogni database embedded ha bisogno di un modo per rispondere a domande come *trova tutti gli utenti con età tra 25 e 35* senza scansionare ogni record. Per BLite, quella risposta è un B+Tree — una struttura d'indice ordinata dove ogni nodo corrisponde a una pagina di storage, e i nodi foglia sono collegati tra loro per supportare i range scan.

Questo post illustra l'implementazione del B+Tree in BLite: il layout dei nodi, l'algoritmo di split, come i path di lettura e scrittura gestiscono i buffer in modo diverso, e perché i nodi foglia portano due puntatori invece di uno.

---

## Perché un Albero e Non un Hash Index

Un hash index risponde alle query punto (`WHERE id = 42`) in O(1) ed è eccellente per le corrispondenze esatte. Non riesce a rispondere alle query di range, e non può restituire risultati in ordine senza una scansione completa e un riordinamento.

Un B-Tree risponde nativamente alle query di range (`WHERE age BETWEEN 25 AND 35`) e alle scansioni ordinate. L'altezza dell'albero è O(log N), quindi le ricerche degradano gradualmente all'aumentare del dataset. Per un database che sarà interrogato con `OrderBy`, range e `Take` di LINQ, un albero è la scelta naturale.

BLite usa specificamente un B+Tree, che differisce da un B-Tree in quanto tutti i valori di dato effettivi (le posizioni dei documenti) vivono nei nodi foglia. I nodi interni memorizzano solo chiavi separatrici per guidare la ricerca. Questo rende i range scan più economici: una volta trovato il confine sinistro di un range, puoi percorrere il livello foglia linearmente senza dover ridiscendere l'albero a ogni passo.

---

## Un Nodo È una Pagina

Il B+Tree di BLite è *page-based*: ogni nodo — foglia o interno — occupa esattamente una pagina di storage. Il `StorageEngine` gestisce l'allocazione delle pagine; il B+Tree gestisce cosa va dentro quelle pagine.

I primi 32 byte di ogni pagina sono un header di pagina generico gestito dal motore di storage. Immediatamente dopo, il B+Tree scrive il proprio header di nodo:

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

`BTreeNodeHeader` è una `struct`, non una classe: 20 byte di puri dati, nessuna allocazione heap, nessun coinvolgimento del GC. `WriteTo` e `ReadFrom` lavorano direttamente su `Span<byte>` e `ReadOnlySpan<byte>`, il che significa che l'header del nodo fa il round-trip su disco senza allocare niente.

I due campi puntatore foglia — `NextLeafPageId` e `PrevLeafPageId` — sono entrambi presenti per una ragione: il puntatore all'indietro permette di scansionare i range in senso inverso, utile per `OrderByDescending` e per query di range dove si supera il confine sinistro e bisogna tornare indietro di un nodo.

---

## Inserire una Entry

Ogni entry in un nodo foglia è una coppia `(IndexKey, DocumentLocation)`. `IndexKey` avvolge i byte grezzi della chiave (rendendola comparabile). `DocumentLocation` è una coppia `(pageId, offset)` che punta al documento effettivo su disco.

Il path di insert usa `ArrayPool` per il suo buffer:

```csharp
public void Insert(IndexKey key, DocumentLocation location, ulong? transactionId = null)
{
    var txnId = transactionId ?? 0;

    if (_options.Unique && TryFind(key, out var existingLocation, txnId))
    {
        if (!existingLocation.Equals(location))
            throw new InvalidOperationException("Violazione unique key");
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

        InsertIntoLeaf(leafPageId, new IndexEntry(key, location), pageBuffer, txnId);
    }
    finally
    {
        ArrayPool<byte>.Shared.Return(pageBuffer);
    }
}
```

Il pattern è consistente in tutto il path di scrittura: prendi in prestito un buffer dal pool, usalo, restituiscilo nel `finally`. Poiché le scritture sono serializzate dal layer di locking delle transazioni, non c'è rischio che lo stesso buffer venga usato in modo concorrente.

`MaxEntriesPerNode` è impostato a 100 nella build di test (deliberatamente basso, per forzare gli split durante i test). Una configurazione di produzione spingerebbe a 400–600, a seconda delle dimensioni di chiave e valore relative alla dimensione della pagina.

---

## Il Path di Lettura: `stackalloc` Invece di `ArrayPool`

Il path di lettura — `TryFind` — è diverso. Non scrive nulla, viene chiamato molto più frequentemente dell'insert, e può permettersi una strategia di allocazione più rigorosa:

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

`stackalloc byte[_storage.PageSize]` mette l'intero buffer di pagina sullo stack del thread. Per pagine da 8 KB su un thread con stack da 1 MB, è comodo. Per pagine da 32 KB con stack di chiamate fortemente ricorsivi, preferiresti `ArrayPool` — è un compromesso dipendente dalla configurazione che non ho ancora risolto completamente.

Il motivo per preferire `stackalloc` qui è il throughput. `TryFind` è il path caldo per ogni predicato `Where` LINQ che colpisce l'indice. La differenza tra un'allocazione stack (un'istruzione) e `ArrayPool.Rent` (un lookup nel thread-local size-class più un CAS) è piccola in termini assoluti, ma si accumula su migliaia di lookup all'indice al secondo.

---

## Lo Splitting dei Nodi

Quando un nodo foglia supera `MaxEntriesPerNode`, deve essere diviso. La procedura di split è la parte più complessa del B+Tree e la più consequente per la correttezza:

1. Alloca una nuova pagina per la metà destra del nodo.
2. Copia la metà superiore delle entry nel nodo destro.
3. Aggiorna la catena di foglie doubly-linked: il `PrevLeafPageId` del nuovo nodo destro punta all'originale, e il `NextLeafPageId` dell'originale punta al nuovo nodo destro.
4. Spingi la prima chiave del nodo destro nel genitore come separatore.
5. Se anche il genitore è pieno, dividi il genitore ricorsivamente (la lista `path` traccia gli antenati esattamente per questo scopo).
6. Se lo split raggiunge la radice, crea una nuova pagina radice.

L'albero cresce verso l'alto dalle foglie, non verso il basso. La radice è l'unico nodo che cambia livello durante uno split, e perde solo entry — non ne accumula mai. Questo garantisce un'altezza bilanciata su tutti i nodi foglia.

---

## Range Scan

Con le foglie doubly-linked, un range scan è un'operazione in due passi:

1. Discendi l'albero per trovare la foglia che conterrebbe la chiave del confine sinistro.
2. Percorri il livello foglia in avanti tramite `NextLeafPageId`, raccogliendo entry fino a superare il confine destro.

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

`yield return` e `yield break` rendono questo un iteratore corretto: il chiamante riceve le entry una per una, e se smette di iterare in anticipo (tramite `Take(20)` per esempio), la scansione si ferma senza leggere le pagine rimanenti.

---

## Cosa Farei Diversamente

**Ricerca binaria all'interno dei nodi foglia**. L'implementazione attuale scansiona le entry linearmente all'interno di una foglia. Con `MaxEntriesPerNode = 100`, sono al massimo 100 confronti. Con una ricerca binaria sarebbero al massimo 7.

**Layout column-store per le foglie**. Il layout attuale memorizza le entry come coppie `(chiave, location)` interlacciate. Un layout column-store metterebbe tutte le chiavi contigue e tutte le location contigue, migliorando l'utilizzo delle cache line per le scansioni solo-chiave (ad esempio per un controllo di unicità).

**`MaxEntriesPerNode` configurabile per indice**. Attualmente è una costante condivisa da tutti gli indici. Un indice su una chiave UUID ha un optimal branching diverso rispetto a un indice su una piccola colonna `byte`.

---

## Conclusione

Il B+Tree è il componente più vecchio e stabile di BLite. I nodi page-based lo mantengono strettamente integrato con il motore di storage. La serializzazione dell'header come `struct` mantiene le allocazioni minime. L'asimmetria path-lettura/scrittura — `stackalloc` per le letture, `ArrayPool` per le scritture — è un compromesso di performance deliberato. E la catena di foglie doubly-linked è il piccolo dettaglio di design che rende le query di range economiche.

Il codice completo è su [GitHub](https://github.com/EntglDb/BLite).
