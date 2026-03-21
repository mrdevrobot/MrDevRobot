---
title: "HNSW Explained: Building a Vector Search Index in .NET from First Principles"
date: "2026-03-17"
description: "How BLite implements the HNSW algorithm for nearest-neighbor vector search — level assignment, greedy layer traversal, Algorithm 4 neighbor selection, and the .NET specifics that keep it allocation-light."
tags: [".net", "blite", "hnsw", "vector-search", "ai", "embeddings", "algorithms", "open-source"]
---

When you store AI-generated embeddings in a database, the query you care about is *find the N documents most similar to this query vector*. That's a nearest-neighbor problem in high-dimensional space, and it's harder than it sounds.

BLite's answer is an HNSW index — Hierarchical Navigable Small World, the algorithm behind most production vector databases today. This post explains how HNSW works, how BLite implements it on top of its page-based storage, and the small .NET-specific choices that keep allocations under control.

---

## Why Exact Nearest-Neighbor Is Slow

Given a query vector $q$ and a dataset of $N$ vectors, the exact nearest neighbor requires computing the distance from $q$ to every vector in the dataset. That's $O(N)$ distance computations — with unit vectors in 1536 dimensions (OpenAI's `text-embedding-3-small` output), each computation is a dot product of 1536 floats.

At 1 million documents, that's 1.5 billion float operations per query. Even on modern hardware with SIMD vectorization, you're looking at tens of milliseconds per query.

**Approximate nearest-neighbor** trades a small accuracy loss for orders-of-magnitude speedup. HNSW achieves $O(\log N)$ query time with recall rates above 95% in typical configurations.

---

## The Intuition: Skip Lists, Not Trees

The original HNSW paper (Malkov & Yashunin, 2018) draws an analogy to skip lists. A skip list is a layered linked list: the bottom layer contains all elements, and each higher layer is a sparser "express lane" for fast navigation.

HNSW builds the same intuition on a graph: the bottom layer (layer 0) is a graph where every node is connected to its nearest neighbors. Higher layers are sparser subgraphs of the same nodes, with longer-range connections. When searching, you enter at the top layer, greedily navigate to the approximate nearest neighbor, then descend to the next layer and repeat — each layer refines the result.

---

## Level Assignment

Each node is assigned a maximum layer when it's inserted. Lower levels are exponentially more probable:

```csharp
private int GetRandomLevel()
{
    // Exponential decay: P(level >= k) = (1/M)^k
    int level = 0;
    while (_random.NextDouble() < 1.0 / _options.M && level < _options.MaxLevel)
        level++;
    return level;
}
```

`_options.M` is the graph's connectivity parameter (typically 8–32). A node assigned level 3 appears in layers 0, 1, 2, and 3. Most nodes are assigned level 0 — they appear only in the bottom layer. A few appear higher up, forming the express lanes.

For thread safety, BLite uses `Random.Shared` on .NET 6+ — a static, lock-free random generator — with a `ThreadLocal<Random>` fallback for older targets:

```csharp
#if NET6_0_OR_GREATER
private static readonly Random _random = Random.Shared;
#else
private static readonly ThreadLocal<Random> _random = new(() => new Random());
#endif
```

---

## Insertion

The insert algorithm follows the paper closely:

```csharp
public void Insert(float[] vector, DocumentLocation docLocation, ITransaction? transaction = null)
{
    if (vector.Length != _options.Dimensions)
        throw new ArgumentException($"Vector dimension mismatch. Expected {_options.Dimensions}, got {vector.Length}");

    int targetLevel = GetRandomLevel();

    // If the index is empty, this node becomes the entry point
    if (_rootPageId == 0)
    {
        InitializeFirstNode(vector, docLocation, targetLevel, transaction);
        return;
    }

    var entryPoint = GetEntryPoint();
    var currentPoint = entryPoint;

    // Phase 1: descend from the top layer down to targetLevel+1
    // using greedy search (single nearest neighbor per layer)
    for (int l = entryPoint.MaxLevel; l > targetLevel; l--)
        currentPoint = GreedySearch(currentPoint, vector, l, transaction);

    // Phase 2: from targetLevel down to 0
    // at each layer: find ef_construction nearest neighbors,
    // select M of them, connect bidirectionally
    var newNode = AllocateNode(vector, docLocation, targetLevel, transaction);

    for (int l = Math.Min(targetLevel, entryPoint.MaxLevel); l >= 0; l--)
    {
        var candidates = SearchLayer(currentPoint, vector, _options.EfConstruction, l, transaction);
        var selected = SelectNeighbors(candidates, vector, _options.M, l, transaction);

        foreach (var neighbor in selected)
            AddBidirectionalLink(newNode, neighbor, l, transaction);

        currentPoint = GreedySearch(currentPoint, vector, l, transaction);
    }

    // If the new node is at a higher level than the current entry point, update it
    if (targetLevel > entryPoint.MaxLevel)
        UpdateEntryPoint(newNode, transaction);
}
```

The two-phase approach is key: phase 1 uses cheap single-neighbor greedy search to get close on the upper layers; phase 2 does richer multi-neighbor search on the layers where the new node will actually live.

---

## Neighbor Selection: Algorithm 4

Selecting *which* neighbors to link to is not just "pick the M closest." The naïve approach creates dense clusters of close nodes connected to each other, with few inter-cluster connections. Queries that start in one cluster can get stuck there, never finding closer nodes in another cluster.

HNSW Algorithm 4 explicitly preserves "bridge" nodes — nodes that connect separate clusters:

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
            // e is "dominated" if some already-selected node r is closer to e than the query is
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

A candidate `e` is "dominated" if there's already a selected neighbor `r` that is closer to `e` than `e` is to the query. Dominated nodes are excluded. This means you prefer nodes that are spread out relative to each other, not clustered around the query.

The practical effect: the resulting graph has better recall across the full vector space because queries starting far from the nearest neighbor can still navigate there via bridge connections, rather than getting stuck in a local neighborhood.

---

## Structure: `NodeReference` as a Struct

Every node in the graph is identified by where it lives on disk:

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

`NodeReference` is a `struct` — it fits in registers, it gets passed and returned by value on the stack, and it can be stored in `List<NodeReference>` without boxing. `MaxLevel` is metadata for traversal; it's deliberately excluded from `Equals` and `GetHashCode` because two references to the same node are equal regardless of what max-level metadata you've cached locally.

---

## Search

Querying for the K nearest neighbors of a vector `q` starts at the entry point (the highest-level node in the graph) and descends:

```csharp
public IReadOnlyList<DocumentLocation> Search(
    float[] query, int k, ITransaction? transaction = null)
{
    if (query.Length != _options.Dimensions)
        throw new ArgumentException("Vector dimension mismatch");

    var entryPoint = GetEntryPoint();
    var currentPoint = entryPoint;

    // Descend from top to layer 1 using greedy single-neighbor search
    for (int l = entryPoint.MaxLevel; l > 0; l--)
        currentPoint = GreedySearch(currentPoint, query, l, transaction);

    // Bottom layer: collect ef candidates, return top k
    var candidates = SearchLayer(currentPoint, query, Math.Max(k, _options.EfSearch), 0, transaction);

    return candidates
        .OrderBy(c => VectorMath.Distance(query, LoadVector(c, transaction), _options.Metric))
        .Take(k)
        .Select(c => LoadLocation(c, transaction))
        .ToList();
}
```

`EfSearch` is the *exploration factor* — how many candidates to consider at layer 0. Higher `EfSearch` means better recall at the cost of more distance computations. The default of 50 gives good recall for most embeddings dimensions; for 1536-dimensional vectors you'd push it to 100–200.

---

## The Distance Metric

BLite supports three metrics:

```csharp
public static float Distance(float[] a, float[] b, VectorMetric metric) => metric switch
{
    VectorMetric.Cosine    => 1f - CosineSimilarity(a, b),
    VectorMetric.Euclidean => EuclideanDistance(a, b),
    VectorMetric.DotProduct => -DotProduct(a, b),  // negate: smaller = closer
    _ => throw new ArgumentException("Unknown metric")
};
```

For AI embeddings from language models, cosine similarity is typically the right choice — it measures the angle between vectors, which captures semantic similarity regardless of magnitude. Euclidean distance is better for spatial data (coordinates, sensor readings). Dot product is appropriate when vectors are already normalized (which OpenAI and most transformer models produce by default).

---

## What's Missing

**The graph structure is not currently persisted separately** from the page-based node data. On a fresh database open, BLite rebuilds the graph in memory from the stored nodes. For small collections this is fast. For millions of vectors, a warm-up cost of several seconds is not acceptable, and the graph edges need their own serialized form.

**No concurrent insert support**. The `LevelUpdateLock` protects the entry-point update, but the global graph structure isn't MVCC-aware. Concurrent inserts are serialized through a coarse lock. This is acceptable for the embedded use case (one writer at a time) but would be a bottleneck in a multi-writer server context.

**No delete/update**. Removing a vector from an HNSW graph requires reconnecting its neighbors — non-trivial compared to deletion in a B-Tree. BLite currently marks deleted nodes as tombstones and filters them at search time, which gradually degrades query performance as the tombstone ratio grows.

---

## The Bottom Line

HNSW is a sophisticated algorithm that earns its complexity through practical recall/latency trade-offs that flat structures can't match at scale. The .NET implementation in BLite stays lightweight by using `struct` node references, pool-rented page buffers, and `Random.Shared` for lock-free level assignment.

The parts that need work — persistence, concurrent writes, clean deletion — are not algorithmic shortcomings. They're engineering debt in the storage integration layer, and they're on the roadmap.

The complete source is on [GitHub](https://github.com/EntglDb/BLite).
