---
title: "Building an IQueryable Provider from Scratch: LINQ over a B-Tree"
date: "2026-02-24"
description: "How BLite translates LINQ expressions into B-Tree page lookups — ExpressionVisitor, predicate merging, hybrid in-memory fallback, and the async streaming trick you can't do without Task.Run."
tags: [".net", "blite", "linq", "iqueryable", "expression-trees", "btree", "open-source", "internals"]
---

One of the first questions people ask when they look at BLite's API is: *can I just use LINQ?* The answer is yes — but making that work honestly was one of the more involved pieces of the whole project.

This post is an inside look at `BTreeQueryable<T>`, the LINQ provider that sits between your `.Where()` calls and the B-Tree pages on disk. I'll show you the four interfaces you need, how `ExpressionVisitor` lets you pull apart a LINQ chain, the hybrid execution model that handles operators the index can't satisfy, and the subtle problem with `IAsyncEnumerable<T>` that cost me an afternoon.

---

## Why Build a LINQ Provider at All

The alternative to an `IQueryable` provider is an explicit query API:

```csharp
db.Users.Find(u => u.Age > 25);
db.Users.RangeScan(startKey: 25, endKey: 35);
```

There's nothing wrong with that design — SQLite's C API works exactly that way. But BLite targets .NET developers who expect LINQ, and a custom API means every consumer writes adapters. The ergonomic cost compounds quickly.

The promise of `IQueryable` is that you write:

```csharp
var results = db.Users
    .Where(u => u.Age > 25 && u.Age < 35)
    .OrderBy(u => u.LastName)
    .Take(20)
    .ToList();
```

...and the database engine sees a structured representation of that query, not a delegate it can't inspect. That representation — an `Expression` tree — is what makes index usage possible.

The cost is that you have to build the machinery to interpret those trees. Let's go through it.

---

## The Four Interfaces

An `IQueryable` provider needs four things:

```csharp
// 1. The queryable itself — the thing your collection exposes
public interface IQueryable<T> : IEnumerable<T>
{
    Type ElementType { get; }
    Expression Expression { get; }
    IQueryProvider Provider { get; }
}

// 2. The provider — executes and creates queryables
public interface IQueryProvider
{
    IQueryable CreateQuery(Expression expression);
    IQueryable<TElement> CreateQuery<TElement>(Expression expression);
    object? Execute(Expression expression);
    TResult Execute<TResult>(Expression expression);
}
```

In BLite, `BTreeQueryable<T>` implements `IQueryable<T>` (plus `IAsyncEnumerable<T>`, more on that later). `BTreeQueryProvider` implements `IQueryProvider`. They're tightly coupled, which is fine — you'll never instantiate them separately.

The key property is `Expression`. For the root queryable it's `Expression.Constant(this)`. Every time you chain an operator — `.Where(...)`, `.OrderBy(...)`, `.Take(...)` — LINQ wraps the previous expression in a `MethodCallExpression`. By the time you call `.ToList()`, `Expression` is a nested call tree representing the entire pipeline.

---

## The Expression Visitor

The job of `BTreeExpressionVisitor` is to *flatten* that nested tree into a `QueryModel` — a plain data structure describing what query to run:

```csharp
internal class QueryModel
{
    public LambdaExpression? WhereClause { get; set; }
    public LambdaExpression? SelectClause { get; set; }
    public LambdaExpression? OrderByClause { get; set; }
    public bool OrderDescending { get; set; }
    public int? Take { get; set; }
    public int? Skip { get; set; }
    public bool HasComplexOperators { get; set; }
}
```

The visitor extends `ExpressionVisitor` and overrides `VisitMethodCall`:

```csharp
internal class BTreeExpressionVisitor : ExpressionVisitor
{
    private readonly QueryModel _model = new();

    public QueryModel GetModel() => _model;

    protected override Expression VisitMethodCall(MethodCallExpression node)
    {
        if (node.Method.DeclaringType == typeof(Queryable))
        {
            switch (node.Method.Name)
            {
                case "Where":      VisitWhere(node);      break;
                case "Select":     VisitSelect(node);     break;
                case "OrderBy":
                case "OrderByDescending": VisitOrderBy(node); break;
                case "Take":       VisitTake(node);       break;
                case "Skip":       VisitSkip(node);       break;
                default:
                    _model.HasComplexOperators = true;
                    break;
            }
        }
        return base.VisitMethodCall(node);
    }
```

`base.VisitMethodCall(node)` is the recursive step — it visits `node.Arguments[0]`, which is the previous expression in the chain, until it hits the root `Constant`. So the visitor naturally traverses from outer to inner, which is why each handler calls `Visit(node.Arguments[0])` first.

The default case catches `GroupBy`, `Join`, `Min`, `Max`, and anything else the B-Tree can't satisfy natively. Setting `HasComplexOperators = true` is the signal to fall through to in-memory LINQ (more on that in a moment).

---

## Combining Multiple Where Clauses

Here's the part that trips people up: a user can write `.Where(...).Where(...)`. Each call produces a separate `MethodCallExpression` with a separate lambda. The visitor sees them as two separate `Where` nodes as it traverses the tree.

The naïve approach is to just overwrite `WhereClause`. That silently drops the first predicate. The correct approach combines them:

```csharp
private void VisitWhere(MethodCallExpression node)
{
    Visit(node.Arguments[0]); // Process inner chain first

    var predicate = (UnaryExpression)node.Arguments[1];
    var lambda = (LambdaExpression)predicate.Operand;

    if (_model.WhereClause == null)
    {
        _model.WhereClause = lambda;
    }
    else
    {
        // Merge: (existing) && (new)
        var parameter = Expression.Parameter(lambda.Parameters[0].Type, "x");
        var merged = Expression.AndAlso(
            Expression.Invoke(_model.WhereClause, parameter),
            Expression.Invoke(lambda, parameter)
        );
        _model.WhereClause = Expression.Lambda(merged, parameter);
    }
}
```

`Expression.AndAlso` builds the `&&` node. `Expression.Invoke` applies the existing lambda to the shared parameter. The result is a new lambda that is logically equivalent to `x => pred1(x) && pred2(x)`.

This is important: when you later `.Compile()` this combined predicate to use as a post-filter in memory, it will behave exactly as the user expects.

---

## The Hybrid Execution Model

Not every LINQ operator maps cleanly to a B-Tree operation. `OrderBy` on an indexed field is free — you're just doing a forward or backward scan. But `GroupBy`, `Join`, `Distinct`, complex projections with nested navigation? The B-Tree doesn't have answers for those.

BLite's solution is a hybrid model: the B-Tree handles what it can (range lookups, ordering, pagination), and anything else falls through to LINQ-to-Objects:

```csharp
// Inside BTreeQueryProvider.Execute<TResult>
var visitor = new BTreeExpressionVisitor();
visitor.Visit(expression);
var model = visitor.GetModel();

// Execute the storage-level query: index scan + predicate filter
IEnumerable<T> storageResults = ExecuteStorageQuery(model);

// If there were operators the B-Tree couldn't handle, apply them in memory
if (model.HasComplexOperators)
{
    // Re-apply the original expression against the materialized sequence
    var inMemoryQueryable = storageResults.AsQueryable();
    return (TResult)(object)inMemoryQueryable.Provider.Execute<TResult>(
        RewriteExpressionForInMemory(expression)
    );
}

return (TResult)(object)ApplyPostProcessing(storageResults, model);
```

The critical assumption here is that the storage query returns a *superset* of the correct result set. Complex operators then filter or reshape in memory. You're never missing rows — you might be doing extra in-memory work, but correctness is guaranteed.

This is the same heuristic used by ORMs like EF Core: evaluate what you can in the database, pull the rest into memory. The difference is that EF Core warns you with a logging message when it does client evaluation. BLite just does it without ceremony — something I'm genuinely undecided about.

---

## Async Streaming: the Task.Run Trick

`IQueryable<T>` is synchronous by design. But embedded databases are often used in mobile apps (MAUI, Blazor WASM) where you cannot block the UI thread. BLite's queryable also implements `IAsyncEnumerable<T>`:

```csharp
internal class BTreeQueryable<T> : IQueryable<T>, IAsyncEnumerable<T>
{
    public async IAsyncEnumerator<T> GetAsyncEnumerator(CancellationToken ct = default)
    {
        var captured = Expression;    // capture before leaving sync context
        var results = await Task.Run(
            () => Provider.Execute<IEnumerable<T>>(captured), ct
        ).ConfigureAwait(false);

        foreach (var item in results)
        {
            ct.ThrowIfCancellationRequested();
            yield return item;
        }
    }
}
```

The trick is `Task.Run`. Query planning and B-Tree traversal are CPU-bound. There's no I/O wait — page files are memory-mapped, so reads are synchronous page faults at the OS level. Wrapping the whole execution in `Task.Run` offloads that CPU work to the thread pool, keeping the calling thread (the UI thread, in a MAUI app) free.

The result is then streamed via `yield return`, which the caller can consume with `await foreach`.

Why capture `Expression` into a local variable before the `Task.Run`? Because the expression tree could theoretically reference captured variables from the calling context. Capturing it explicitly ensures we pass the right snapshot to the thread pool, even if — honestly — in practice `Expression` is already immutable on `BTreeQueryable<T>`.

One thing this design does *not* do: it does not stream pages lazily from disk. The entire result set is materialized in the thread pool task before streaming starts. For truly lazy streaming you'd need a coroutine-style approach that yields across page boundaries — I experimented with it, found the complexity non-trivial, and deferred it.

---

## What the Provider Actually Executes

When `ExecuteStorageQuery` receives a `QueryModel`, it does the following:

1. **Index probe**: If `WhereClause` references an indexed field, translate the predicate bounds into a `BTreeIndex.RangeScan` call. This gives raw `DocumentLocation` values — `(pageId, offset)` pairs pointing to where each document lives on disk.

2. **Page reads**: For each `DocumentLocation`, issue a page read (memory-mapped, so effectively free if the OS has the page warm). Deserialize the document via the generated mapper.

3. **Post-filter**: Apply `WhereClause.Compile()` against the deserialized objects to handle compound predicates that couldn't be pushed to the index.

4. **Order, skip, take**: Apply in-memory after the filter. `OrderBy` is only "free" if it's on the same field as the index scan, and the scan is already ordered. In all other cases it materializes and sorts.

This is where the honest cost accounting matters. The B-Tree gives you fast *lookup*, but once you've looked up a set of documents, everything downstream is still O(N) over that set. The index reduces N dramatically — but it's not zero-cost magic.

---

## The Parts I'm Not Satisfied With

**Expression rewriting for in-memory fallback** is fragile. When `HasComplexOperators` is true, BLite re-executes the original expression tree against an in-memory queryable. That requires stripping out the `BTreeQueryable` root and replacing it with an `EnumerableQuery`. The rewriting logic is brittle — nested subqueries, for instance, break it in non-obvious ways. EF Core solves this with a much heavier expression normalization pass that I haven't written yet.

**Index selection** is primitive. BLite currently chooses at most one index per query, based on a simple property-name match. If you have a compound predicate like `WHERE age > 25 AND country = "IT"`, it picks whichever matching index it finds first. A real query planner would estimate cardinalities and pick the most selective index.

**No predicate pushdown into the visitor**. The visitor extracts the lambda but doesn't analyze *what's inside it*. Knowing that `u.Age > 25` is a range predicate on `Age` requires a second visitor pass over the lambda body. That second pass is where `BinaryExpression`, `MemberExpression`, and `ConstantExpression` live — and it's non-trivial to make it handle all the cases developers throw at it (null checks, method calls, coercions).

---

## The Bottom Line

Building an `IQueryable` provider feels more approachable once you see that it's largely boilerplate: implement four methods, write one visitor. The interesting engineering is in the execution layer — deciding what to push to the index and what to fall back to in-memory — and in handling the edge cases the visitor doesn't anticipate.

For BLite's use case (single-developer embedded database, controlled schema, small-to-medium data sets), the hybrid approach works well. The LINQ surface is familiar, the compilation step catches typos, and the async streaming keeps mobile UIs responsive.

For a general-purpose query engine, the work is substantially larger. But that was never the goal.

The complete source is on [GitHub](https://github.com/EntglDb/BLite) if you want to trace the exact execution path.
