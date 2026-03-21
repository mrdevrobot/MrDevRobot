---
title: "Costruire un IQueryable Provider da zero: LINQ su un B-Tree"
date: "2026-02-24"
description: "Come BLite traduce le espressioni LINQ in page lookup sul B-Tree — ExpressionVisitor, fusione dei predicati, fallback in-memory e il trucco con Task.Run per lo streaming asincrono."
tags: [".net", "blite", "linq", "iqueryable", "expression-trees", "btree", "open-source", "internals"]
---

Una delle prime domande che mi viene fatta quando qualcuno guarda l'API di BLite è: *posso usare LINQ?* La risposta è sì — ma far funzionare quella cosa onestamente è stato uno dei pezzi più articolati dell'intero progetto.

Questo post è uno sguardo interno a `BTreeQueryable<T>`, il LINQ provider che si frappone tra le tue chiamate `.Where()` e le pagine del B-Tree su disco. Ti mostro le quattro interfacce necessarie, come `ExpressionVisitor` permette di smontare una catena LINQ, il modello di esecuzione ibrido che gestisce gli operatori che l'indice non riesce a soddisfare, e il problema sottile con `IAsyncEnumerable<T>` che mi ha fatto perdere un pomeriggio.

---

## Perché costruire un LINQ provider

L'alternativa a un provider `IQueryable` è un'API di query esplicita:

```csharp
db.Users.Find(u => u.Age > 25);
db.Users.RangeScan(startKey: 25, endKey: 35);
```

Non c'è niente di sbagliato in quel design — l'API C di SQLite funziona esattamente così. Ma BLite si rivolge a sviluppatori .NET che si aspettano LINQ, e un'API proprietaria significa che ogni consumer scrive adattatori. Il costo ergonomico si accumula in fretta.

La promessa di `IQueryable` è che scrivi:

```csharp
var results = db.Users
    .Where(u => u.Age > 25 && u.Age < 35)
    .OrderBy(u => u.LastName)
    .Take(20)
    .ToList();
```

...e il motore del database vede una rappresentazione strutturata di quella query, non un delegate che non può ispezionare. Quella rappresentazione — un albero di `Expression` — è ciò che rende possibile l'uso degli indici.

Il costo è che bisogna costruire la macchina per interpretare quegli alberi. Vediamo come.

---

## Le quattro interfacce

Un provider `IQueryable` ha bisogno di quattro cose:

```csharp
// 1. Il queryable — quello che la collection espone
public interface IQueryable<T> : IEnumerable<T>
{
    Type ElementType { get; }
    Expression Expression { get; }
    IQueryProvider Provider { get; }
}

// 2. Il provider — esegue e crea queryable
public interface IQueryProvider
{
    IQueryable CreateQuery(Expression expression);
    IQueryable<TElement> CreateQuery<TElement>(Expression expression);
    object? Execute(Expression expression);
    TResult Execute<TResult>(Expression expression);
}
```

In BLite, `BTreeQueryable<T>` implementa `IQueryable<T>` (più `IAsyncEnumerable<T>`, ci torniamo dopo). `BTreeQueryProvider` implementa `IQueryProvider`. Sono accoppiati strettamente, il che va bene — non li istanzierai mai separatamente.

La proprietà chiave è `Expression`. Per il queryable root è `Expression.Constant(this)`. Ogni volta che concateni un operatore — `.Where(...)`, `.OrderBy(...)`, `.Take(...)` — LINQ avvolge l'espressione precedente in una `MethodCallExpression`. Quando chiami `.ToList()`, `Expression` è un albero di chiamate annidate che rappresenta l'intera pipeline.

---

## Il visitor delle espressioni

Il compito di `BTreeExpressionVisitor` è *appiattire* quell'albero annidato in un `QueryModel` — una struttura dati semplice che descrive quale query eseguire:

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

Il visitor estende `ExpressionVisitor` e sovrascrive `VisitMethodCall`:

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

`base.VisitMethodCall(node)` è il passo ricorsivo — visita `node.Arguments[0]`, che è l'espressione precedente nella catena, finché non raggiunge la radice `Constant`. Quindi il visitor attraversa naturalmente dall'esterno verso l'interno, ecco perché ogni handler chiama prima `Visit(node.Arguments[0])`.

Il caso `default` cattura `GroupBy`, `Join`, `Min`, `Max` e tutto ciò che il B-Tree non riesce a soddisfare nativamente. Impostare `HasComplexOperators = true` è il segnale per ricadere su LINQ in-memory (ne parlo tra un momento).

---

## Combinare più clausole Where

Ecco la parte che trae in inganno: un utente può scrivere `.Where(...).Where(...)`. Ogni chiamata produce una `MethodCallExpression` separata con una lambda separata. Il visitor le vede come due nodi `Where` distinti mentre attraversa l'albero.

L'approccio naïve è sovrascrivere semplicemente `WhereClause`. Quello che fa è eliminare silenziosamente il primo predicato. L'approccio corretto li combina:

```csharp
private void VisitWhere(MethodCallExpression node)
{
    Visit(node.Arguments[0]); // Prima elabora la catena interna

    var predicate = (UnaryExpression)node.Arguments[1];
    var lambda = (LambdaExpression)predicate.Operand;

    if (_model.WhereClause == null)
    {
        _model.WhereClause = lambda;
    }
    else
    {
        // Fusione: (esistente) && (nuovo)
        var parameter = Expression.Parameter(lambda.Parameters[0].Type, "x");
        var merged = Expression.AndAlso(
            Expression.Invoke(_model.WhereClause, parameter),
            Expression.Invoke(lambda, parameter)
        );
        _model.WhereClause = Expression.Lambda(merged, parameter);
    }
}
```

`Expression.AndAlso` costruisce il nodo `&&`. `Expression.Invoke` applica la lambda esistente al parametro condiviso. Il risultato è una nuova lambda logicamente equivalente a `x => pred1(x) && pred2(x)`.

È importante: quando in seguito `.Compile()` questo predicato combinato per usarlo come post-filtro in memoria, si comporterà esattamente come l'utente si aspetta.

---

## Il modello di esecuzione ibrido

Non ogni operatore LINQ si traduce elegantemente in un'operazione sul B-Tree. `OrderBy` su un campo indicizzato è gratuito — stai semplicemente facendo una scansione in avanti o a ritroso. Ma `GroupBy`, `Join`, `Distinct`, proiezioni complesse con navigazione annidata? Il B-Tree non ha risposta per quelle.

La soluzione di BLite è un modello ibrido: il B-Tree gestisce ciò che può (range lookup, ordinamento, paginazione), e tutto il resto ricade su LINQ-to-Objects:

```csharp
// Dentro BTreeQueryProvider.Execute<TResult>
var visitor = new BTreeExpressionVisitor();
visitor.Visit(expression);
var model = visitor.GetModel();

// Esegui la query a livello storage: index scan + filtro predicato
IEnumerable<T> storageResults = ExecuteStorageQuery(model);

// Se c'erano operatori che il B-Tree non poteva gestire, applicali in memoria
if (model.HasComplexOperators)
{
    var inMemoryQueryable = storageResults.AsQueryable();
    return (TResult)(object)inMemoryQueryable.Provider.Execute<TResult>(
        RewriteExpressionForInMemory(expression)
    );
}

return (TResult)(object)ApplyPostProcessing(storageResults, model);
```

L'assunzione critica qui è che la query storage restituisca un *superset* del result set corretto. Gli operatori complessi poi filtrano o rimodellano in memoria. Non si perdono mai righe — potresti fare lavoro in-memory extra, ma la correttezza è garantita.

È la stessa euristica usata da ORM come EF Core: valuta ciò che puoi nel database, porta il resto in memoria. La differenza è che EF Core ti avvisa con un messaggio di log quando fa client evaluation. BLite lo fa semplicemente senza cerimonie — una scelta su cui sono genuinamente indeciso.

---

## Streaming asincrono: il trucco con Task.Run

`IQueryable<T>` è sincrono per design. Ma i database embedded sono spesso usati in app mobile (MAUI, Blazor WASM) dove non puoi bloccare il thread UI. Il queryable di BLite implementa anche `IAsyncEnumerable<T>`:

```csharp
internal class BTreeQueryable<T> : IQueryable<T>, IAsyncEnumerable<T>
{
    public async IAsyncEnumerator<T> GetAsyncEnumerator(CancellationToken ct = default)
    {
        var captured = Expression;    // cattura prima di lasciare il contesto sincrono
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

Il trucco è `Task.Run`. La pianificazione delle query e l'attraversamento del B-Tree sono CPU-bound. Non c'è attesa di I/O — i file di pagine sono memory-mapped, quindi le letture sono page fault sincroni a livello OS. Avvolgere l'intera esecuzione in `Task.Run` scarica quel lavoro CPU sul thread pool, mantenendo libero il thread chiamante (il thread UI, in un'app MAUI).

Il risultato viene poi messo in streaming via `yield return`, che il chiamante può consumare con `await foreach`.

Perché catturare `Expression` in una variabile locale prima del `Task.Run`? Perché l'albero delle espressioni potrebbe teoricamente riferirsi a variabili catturate dal contesto chiamante. Catturarla esplicitamente garantisce che passiamo lo snapshot corretto al thread pool, anche se — onestamente — in pratica `Expression` è già immutabile su `BTreeQueryable<T>`.

Una cosa che questo design *non* fa: non mette le pagine in streaming in modo pigro dal disco. L'intero result set viene materializzato nel task del thread pool prima che inizi lo streaming. Per uno streaming veramente lazy servirebbe un approccio coroutine che fa yield attraverso i confini delle pagine — ci ho sperimentato, ho trovato la complessità non banale, e l'ho rimandato.

---

## Cosa esegue il provider

Quando `ExecuteStorageQuery` riceve un `QueryModel`, fa quanto segue:

1. **Index probe**: Se `WhereClause` fa riferimento a un campo indicizzato, traduce i limiti del predicato in una chiamata `BTreeIndex.RangeScan`. Questo fornisce valori `DocumentLocation` grezzi — coppie `(pageId, offset)` che puntano a dove ogni documento vive su disco.

2. **Page reads**: Per ogni `DocumentLocation`, esegue una lettura di pagina (memory-mapped, quindi praticamente gratuita se l'OS ha la pagina warm). Deserializza il documento tramite il mapper generato.

3. **Post-filter**: Applica `WhereClause.Compile()` sugli oggetti deserializzati per gestire i predicati composti che non si potevano spingere sull'indice.

4. **Order, skip, take**: Applicati in-memory dopo il filtro. `OrderBy` è "gratuito" solo se è sullo stesso campo della scansione dell'indice, e la scansione è già ordinata. In tutti gli altri casi materializza e ordina.

Qui è dove conta la contabilità onesta dei costi. Il B-Tree fornisce un *lookup* veloce, ma una volta recuperato un insieme di documenti, tutto ciò che viene dopo è comunque O(N) su quell'insieme. L'indice riduce N drasticamente — ma non è magia a costo zero.

---

## Le parti di cui non sono soddisfatto

**La riscrittura delle espressioni per il fallback in-memory** è fragile. Quando `HasComplexOperators` è true, BLite riesegue l'albero delle espressioni originale contro un queryable in-memory. Questo richiede di rimuovere la radice `BTreeQueryable` e sostituirla con un `EnumerableQuery`. La logica di riscrittura è fragile — le subquery annidate, per esempio, la rompono in modi non ovvi. EF Core risolve questo con un passaggio di normalizzazione delle espressioni molto più pesante che non ho ancora scritto.

**La selezione dell'indice** è primitiva. BLite attualmente sceglie al massimo un indice per query, basandosi su una semplice corrispondenza del nome della proprietà. Se hai un predicato composto come `WHERE age > 25 AND country = "IT"`, sceglie qualunque indice corrispondente trovi per primo. Un vero query planner stimerebbe le cardinalità e sceglierebbe l'indice più selettivo.

**Nessun predicate pushdown nel visitor**. Il visitor estrae la lambda ma non analizza *cosa c'è dentro*. Sapere che `u.Age > 25` è un predicato di range su `Age` richiede un secondo passaggio del visitor sul corpo della lambda. Quel secondo passaggio è dove vivono `BinaryExpression`, `MemberExpression` e `ConstantExpression` — ed è non banale gestire tutti i casi che gli sviluppatori ci passano (null check, chiamate a metodi, coercions).

---

## La conclusione

Costruire un provider `IQueryable` sembra più abbordabile una volta che capisci che è in gran parte boilerplate: implementa quattro metodi, scrivi un visitor. L'ingegneria interessante sta nel livello di esecuzione — decidere cosa spingere sull'indice e cosa ricadere in-memory — e nella gestione dei casi limite che il visitor non anticipa.

Per il caso d'uso di BLite (database embedded a singolo sviluppatore, schema controllato, dataset piccoli o medi), l'approccio ibrido funziona bene. La superficie LINQ è familiare, il passaggio di compilazione cattura i typo, e lo streaming asincrono mantiene responsive le UI mobile.

Per un motore di query general-purpose, il lavoro è sostanzialmente più grande. Ma non era mai quello l'obiettivo.

Il codice completo è su [GitHub](https://github.com/EntglDb/BLite) se vuoi tracciare l'esatto percorso di esecuzione.
