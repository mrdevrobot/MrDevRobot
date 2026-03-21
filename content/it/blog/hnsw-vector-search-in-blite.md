---
title: "HNSW Spiegato: Costruire un Indice di Ricerca Vettoriale in .NET dai Primi Principi"
date: "2026-03-17"
description: "Come BLite implementa l'algoritmo HNSW per la ricerca nearest-neighbor — assegnazione dei livelli, traversata greedy per layer, selezione dei vicini con l'Algoritmo 4 e i dettagli .NET che mantengono le allocazioni sotto controllo."
tags: [".net", "blite", "hnsw", "vector-search", "ai", "embeddings", "algorithms", "open-source"]
---

Quando si archiviano embedding generati da AI in un database, la query che conta è *trova gli N documenti più simili a questo vettore di query*. È un problema di nearest-neighbor in spazio ad alta dimensione, e è più difficile di quanto sembri.

La risposta di BLite è un indice HNSW — Hierarchical Navigable Small World, l'algoritmo alla base della maggior parte dei database vettoriali in produzione oggi. Questo articolo spiega come funziona HNSW, come BLite lo implementa sopra lo storage page-based, e le piccole scelte .NET-specifiche che tengono le allocazioni sotto controllo.

---

## Perché la Ricerca Esatta del Nearest Neighbor è Lenta

Dato un vettore di query $q$ e un dataset di $N$ vettori, il nearest neighbor esatto richiede di calcolare la distanza da $q$ a ogni vettore nel dataset. Questo significa $O(N)$ calcoli di distanza — con vettori unitari a 1536 dimensioni (output di OpenAI `text-embedding-3-small`), ogni calcolo è un prodotto scalare di 1536 float.

Con un milione di documenti si parla di 1,5 miliardi di operazioni su float per query. Anche su hardware moderno con vettorizzazione SIMD, ci vogliono decine di millisecondi per query.

Il **nearest-neighbor approssimato** scambia una piccola perdita di accuratezza per un miglioramento di ordini di grandezza nella velocità. HNSW raggiunge un tempo di query $O(\log N)$ con tassi di recall superiori al 95% nelle configurazioni tipiche.

---

## L'Intuizione: Skip List, non Alberi

Il paper originale HNSW (Malkov & Yashunin, 2018) fa un'analogia con le skip list. Una skip list è una linked list a livelli: il livello inferiore contiene tutti gli elementi, mentre ogni livello superiore è una "corsia preferenziale" più rada per la navigazione rapida.

HNSW costruisce la stessa intuizione su un grafo: il livello inferiore (layer 0) è un grafo dove ogni nodo è connesso ai suoi nearest neighbor. I livelli superiori sono sottografi più radi degli stessi nodi, con connessioni a maggiore distanza. Nella ricerca si entra dal livello più alto, si naviga greedy verso il nearest neighbor approssimato, poi si scende al livello successivo e si ripete — ogni layer raffina il risultato.

---

## Assegnazione dei Livelli

A ogni nodo viene assegnato un livello massimo al momento dell'inserimento. I livelli inferiori sono esponenzialmente più probabili:

```csharp
private int GetRandomLevel()
{
    // Decadimento esponenziale: P(level >= k) = (1/M)^k
    int level = 0;
    while (_random.NextDouble() < 1.0 / _options.M && level < _options.MaxLevel)
        level++;
    return level;
}
```

`_options.M` è il parametro di connettività del grafo (tipicamente 8–32). Un nodo assegnato al livello 3 appare nei layer 0, 1, 2 e 3. La maggior parte dei nodi viene assegnata al livello 0 — appare solo nel layer inferiore. Pochi appaiono nei livelli superiori, formando le corsie preferenziali.

Per la thread safety, BLite usa `Random.Shared` su .NET 6+ — un generatore casuale statico e lock-free — con un fallback `ThreadLocal<Random>` per target precedenti:

```csharp
#if NET6_0_OR_GREATER
private static readonly Random _random = Random.Shared;
#else
private static readonly ThreadLocal<Random> _random = new(() => new Random());
#endif
```

---

## Inserimento

L'algoritmo di inserimento segue fedelmente il paper:

```csharp
public void Insert(float[] vector, DocumentLocation docLocation, ITransaction? transaction = null)
{
    if (vector.Length != _options.Dimensions)
        throw new ArgumentException($"Dimensione vettore errata. Attesa {_options.Dimensions}, ricevuta {vector.Length}");

    int targetLevel = GetRandomLevel();

    // Se l'indice è vuoto, questo nodo diventa l'entry point
    if (_rootPageId == 0)
    {
        InitializeFirstNode(vector, docLocation, targetLevel, transaction);
        return;
    }

    var entryPoint = GetEntryPoint();
    var currentPoint = entryPoint;

    // Fase 1: discendi dal livello più alto fino a targetLevel+1
    // usando la ricerca greedy (singolo nearest neighbor per layer)
    for (int l = entryPoint.MaxLevel; l > targetLevel; l--)
        currentPoint = GreedySearch(currentPoint, vector, l, transaction);

    // Fase 2: da targetLevel fino a 0
    // per ogni layer: trova ef_construction nearest neighbor,
    // selezionane M, connettili bidirezionalmente
    var newNode = AllocateNode(vector, docLocation, targetLevel, transaction);

    for (int l = Math.Min(targetLevel, entryPoint.MaxLevel); l >= 0; l--)
    {
        var candidates = SearchLayer(currentPoint, vector, _options.EfConstruction, l, transaction);
        var selected = SelectNeighbors(candidates, vector, _options.M, l, transaction);

        foreach (var neighbor in selected)
            AddBidirectionalLink(newNode, neighbor, l, transaction);

        currentPoint = GreedySearch(currentPoint, vector, l, transaction);
    }

    // Se il nuovo nodo è a un livello più alto dell'entry point corrente, aggiornalo
    if (targetLevel > entryPoint.MaxLevel)
        UpdateEntryPoint(newNode, transaction);
}
```

L'approccio a due fasi è fondamentale: la fase 1 usa la ricerca greedy a singolo vicino, economica, per avvicinarsi nei layer superiori; la fase 2 effettua una ricerca multi-vicino più ricca nei layer dove il nuovo nodo vivrà realmente.

---

## Selezione dei Vicini: Algoritmo 4

Scegliere *quali* vicini collegare non significa semplicemente "prendi gli M più vicini." L'approccio ingenuo crea cluster densi di nodi vicini collegati tra loro, con poche connessioni inter-cluster. Le query che partono da un cluster possono bloccarsi lì, senza mai trovare nodi più vicini in un altro cluster.

L'Algoritmo 4 di HNSW preserva esplicitamente i nodi "ponte" — nodi che connettono cluster separati:

```csharp
private List<NodeReference> SelectNeighbors(
    IEnumerable<NodeReference> candidates,
    float[] query, int m, int level,
    ITransaction? transaction)
{
    var result = new List<NodeReference>(m);

    foreach (var e in candidates)
    {
        float distEQ = VectorMath.Distance(query, LoadVector(e, transaction), _options.Metric);
        bool dominated = false;

        foreach (var r in result)
        {
            // e è "dominato" se qualche nodo già selezionato r è più vicino a e
            // di quanto lo sia la query
            float distER = VectorMath.Distance(
                LoadVector(e, transaction), LoadVector(r, transaction), _options.Metric);
            if (distER < distEQ)
            {
                dominated = true;
                break;
            }
        }

        if (!dominated && result.Count < m)
            result.Add(e);
    }

    return result;
}
```

Un candidato `e` è "dominato" se esiste già un vicino selezionato `r` che è più vicino a `e` di quanto `e` sia alla query. I nodi dominati vengono esclusi. Questo significa preferire nodi distribuiti tra loro, non raggruppati attorno alla query.

L'effetto pratico: il grafo risultante ha un recall migliore sull'intero spazio vettoriale, perché le query che partono lontano dal nearest neighbor possono comunque navigarci attraverso connessioni ponte, invece di bloccarsi in un vicinato locale.

---

## Struttura: `NodeReference` come Struct

Ogni nodo nel grafo è identificato da dove risiede su disco:

```csharp
private struct NodeReference : IEquatable<NodeReference>
{
    public uint PageId;
    public int NodeIndex;
    public int MaxLevel;

    public bool Equals(NodeReference other) =>
        PageId == other.PageId && NodeIndex == other.NodeIndex;

    public override int GetHashCode() => HashCode.Combine(PageId, NodeIndex);
}
```

`NodeReference` è una `struct` — sta nei registri, viene passata e restituita per valore nello stack, e può essere memorizzata in `List<NodeReference>` senza boxing. `MaxLevel` è metadato per la traversata; è volutamente escluso da `Equals` e `GetHashCode` perché due riferimenti allo stesso nodo sono uguali indipendentemente dal livello massimo memorizzato localmente.

---

## Ricerca

La query per i K nearest neighbor di un vettore `q` inizia dall'entry point (il nodo al livello più alto nel grafo) e scende:

```csharp
public IReadOnlyList<DocumentLocation> Search(
    float[] query, int k, ITransaction? transaction = null)
{
    if (query.Length != _options.Dimensions)
        throw new ArgumentException("Dimensione vettore errata");

    var entryPoint = GetEntryPoint();
    var currentPoint = entryPoint;

    // Discendi dal livello più alto al layer 1 con ricerca greedy a singolo vicino
    for (int l = entryPoint.MaxLevel; l > 0; l--)
        currentPoint = GreedySearch(currentPoint, query, l, transaction);

    // Layer inferiore: raccogli ef candidati, restituisci i top k
    var candidates = SearchLayer(currentPoint, query, Math.Max(k, _options.EfSearch), 0, transaction);

    return candidates
        .OrderBy(c => VectorMath.Distance(query, LoadVector(c, transaction), _options.Metric))
        .Take(k)
        .Select(c => LoadLocation(c, transaction))
        .ToList();
}
```

`EfSearch` è il *fattore di esplorazione* — quanti candidati considerare nel layer 0. Un `EfSearch` più alto significa recall migliore a costo di più calcoli di distanza. Il default di 50 fornisce un buon recall per la maggior parte delle dimensioni; per vettori a 1536 dimensioni conviene alzarlo a 100–200.

---

## La Metrica di Distanza

BLite supporta tre metriche:

```csharp
public static float Distance(float[] a, float[] b, VectorMetric metric) => metric switch
{
    VectorMetric.Cosine    => 1f - CosineSimilarity(a, b),
    VectorMetric.Euclidean => EuclideanDistance(a, b),
    VectorMetric.DotProduct => -DotProduct(a, b),  // negato: più piccolo = più vicino
    _ => throw new ArgumentException("Metrica sconosciuta")
};
```

Per gli embedding AI da language model, la cosine similarity è tipicamente la scelta giusta — misura l'angolo tra vettori, che cattura la similarità semantica indipendentemente dalla magnitudine. La distanza euclidea è migliore per dati spaziali (coordinate, letture di sensori). Il dot product è appropriato quando i vettori sono già normalizzati (come producono di default OpenAI e la maggior parte dei modelli transformer).

---

## Cosa Manca

**La struttura del grafo non è attualmente persistita separatamente** dai dati dei nodi page-based. Alla riapertura di un database, BLite ricostruisce il grafo in memoria dai nodi archiviati. Per piccole collezioni è veloce. Per milioni di vettori, un costo di warm-up di svariati secondi non è accettabile, e gli archi del grafo necessitano di una loro forma serializzata.

**Nessun supporto per inserimento concorrente**. Il `LevelUpdateLock` protegge l'aggiornamento dell'entry point, ma la struttura globale del grafo non è MVCC-aware. Gli inserimenti concorrenti vengono serializzati attraverso un lock grossolano. Questo è accettabile per il caso d'uso embedded (uno scrittore alla volta) ma sarebbe un bottleneck in un contesto server multi-writer.

**Nessuna cancellazione/aggiornamento**. Rimuovere un vettore da un grafo HNSW richiede di riconnettere i suoi vicini — non banale rispetto alla cancellazione in un B-Tree. BLite attualmente marca i nodi eliminati come tombstone e li filtra al momento della ricerca, il che degrada gradualmente le performance di query man mano che il rapporto di tombstone cresce.

---

## Il Verdetto

HNSW è un algoritmo sofisticato che guadagna la sua complessità attraverso trade-off recall/latenza pratici che le strutture piatte non possono eguagliare a scala. L'implementazione .NET in BLite rimane leggera usando riferimenti ai nodi come `struct`, buffer di pagina presi dal pool, e `Random.Shared` per l'assegnazione lock-free dei livelli.

Le parti che necessitano lavoro — persistenza, scritture concorrenti, cancellazione pulita — non sono carenze algoritmiche. Sono debito tecnico nel layer di integrazione con lo storage, e sono nella roadmap.

Il sorgente completo è su [GitHub](https://github.com/EntglDb/BLite).
