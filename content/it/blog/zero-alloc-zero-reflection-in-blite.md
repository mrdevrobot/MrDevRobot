---
title: "Zero Alloc, Zero Reflection: Come BLite Gestisce Oggetti Complessi ad Alta Velocità"
date: "2026-03-21"
description: "Due sfide ingegneristiche in BLite: supportare campi privati, costruttori privati e collection annidate senza reflection a runtime — e gestire i buffer di serializzazione senza pressione sul GC."
tags: [".net", "blite", "performance", "reflection", "span", "source-generators", "memory", "open-source"]
image: "/avatar.jpg"
---

Quando ho iniziato a scrivere BLite mi sono posto due vincoli rigidi:

1. **Nessuna reflection sul critical path.** Ogni chiamata a `Insert`, `Find` o `Update` doveva essere priva di `MethodInfo.Invoke`, `PropertyInfo.SetValue` e compagnia.
2. **Nessuna allocazione heap non necessaria.** La pipeline di serializzazione non doveva affaticare il GC più del necessario.

Entrambi si sono rivelati più difficili del previsto. Questo articolo spiega le tecniche che ho adottato e i problemi specifici che mi hanno spinto verso ciascuna.

---

## Parte I — Il Problema della Reflection

### Perché la reflection è difficile da evitare

Una libreria di serializzazione deve fare due cose che normalmente richiedono la reflection: *creare un'istanza di un tipo che non ha mai visto prima*, e *impostare proprietà su quell'istanza*. L'approccio ovvio è:

```csharp
var entity = Activator.CreateInstance(typeof(OrderEntity));
typeof(OrderEntity).GetProperty("Status")!.SetValue(entity, value);
```

Funziona per il 90% dei tipi reali. Si rompe silenziosamente per l'altro 10%:

- **Costruttori privati** — gli aggregate DDD spesso sigillano i costruttori per imporre invarianti.
- **Setter `init`-only** — molto usati da C# 9 in poi, impossibili da chiamare via `PropertyInfo.SetValue` dopo la costruzione.
- **Backing field privati** — quando si espone `IReadOnlyCollection<T>` ma si memorizza `List<T>` internamente, il setter della proprietà semplicemente non esiste.
- **Prestazioni** — anche con caching, `PropertyInfo.SetValue` fa boxing dei value type e aggiunge overhead di dispatch su ogni chiamata.

### Step 1: Spostare l'analisi a compile time

Il primo insight è stato che la reflection è costosa solo *a runtime*. Se tutto il lavoro di ispezione dei tipi poteva avvenire a compile time generando codice C# ordinario, il runtime non avrebbe visto altro che chiamate a metodi e assegnazioni a campi normali.

BLite usa un **Roslyn Source Generator** (`IIncrementalGenerator`) che viene eseguito durante la compilazione. Visita ogni classe referenziata da un `DocumentDbContext`, ne ispeziona i membri tramite l'API Roslyn `INamedTypeSymbol`, ed emette una classe mapper concreta:

```csharp
// Eseguito a compile time — zero costo a runtime
var hasPublicParameterlessCtor = entityType.Constructors
    .Any(c => c.DeclaredAccessibility == Accessibility.Public
              && c.Parameters.Length == 0);

entityInfo.HasPrivateOrNoConstructor = !hasPublicParameterlessCtor;

// Trova il backing field DDD: _propertyName
conventionalBackingField = SyntaxHelper.FindConventionalBackingField(prop);
```

Il generatore conosce, a build time, quali proprietà hanno setter privati, se il costruttore è accessibile e se c'è un backing field di cui preoccuparsi.

### Step 2: Expression Trees per setter privati e `init`-only

Per le proprietà che hanno un setter — anche privato o `init`-only — il mapper generato crea un delegate `Action<TObj, TVal>` compilato durante l'inizializzazione del tipo (la prima volta che la classe statica viene caricata), e lo mantiene in un campo `static readonly`:

```csharp
// Codice generato — eseguito una sola volta per lifetime dell'appdomain
private static readonly Action<OrderEntity, string> _setter_Status =
    CreateSetter<OrderEntity, string>("Status");

private static Action<TObj, TVal> CreateSetter<TObj, TVal>(string propertyName)
{
    var param  = Expression.Parameter(typeof(TObj), "obj");
    var value  = Expression.Parameter(typeof(TVal), "val");
    var prop   = Expression.Property(param, propertyName);
    var assign = Expression.Assign(prop, value);
    return Expression.Lambda<Action<TObj, TVal>>(assign, param, value).Compile();
}
```

`Expression.Lambda(...).Compile()` produce IL reale — lo stesso IL che il compilatore C# avrebbe emesso se il setter fosse pubblico. A runtime, chiamare `_setter_Status(entity, "shipped")` è indistinguibile in costo dal chiamare un setter pubblico normale.

La compilazione avviene *una sola volta*, all'inizializzazione del campo `static readonly`. Dopo di allora, ogni chiamata di deserializzazione non paga nulla.

### Step 3: `RuntimeHelpers.GetUninitializedObject` per costruttori privati

E per i tipi senza alcun costruttore accessibile? Il mapper generato usa `RuntimeHelpers.GetUninitializedObject` per aggirare completamente il costruttore:

```csharp
// Codice di deserializzazione generato
var entity = (OrderEntity)
    RuntimeHelpers.GetUninitializedObject(typeof(OrderEntity));

// Le proprietà vengono poi impostate tramite delegate compilati:
_setter_Status(entity, status ?? default!);
entity.Name = name ?? default!;
```

`GetUninitializedObject` alloca l'oggetto managed e azzera la sua memoria senza invocare nessun costruttore. È lo stesso meccanismo che il runtime .NET usa internamente per la deserializzazione. È sicuro purché si inizializzino correttamente tutti i campi successivamente — cosa che il mapper generato fa, avendo piena conoscenza dei membri del tipo a compile time.

### Step 4: `[UnsafeAccessor]` per backing field privati (NET 8+)

Il caso più insidioso è il pattern DDD dove una collection è memorizzata come `List<T>` privata ma esposta come `IReadOnlyCollection<T>`. Non esiste un setter, e il backing field ha un nome "nascosto":

```csharp
public class Order
{
    private readonly List<LineItem> _items = new();
    public IReadOnlyCollection<LineItem> Items => _items.AsReadOnly();
}
```

Su .NET 8 e versioni successive, il generatore emette un attributo `[UnsafeAccessor]` — una funzionalità che consente di referenziare un membro privato per nome con *zero overhead* a runtime. Il JIT lo risolve in un accesso diretto al campo, senza reflection:

```csharp
#if NET8_0_OR_GREATER
[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "_items")]
private static extern ref List<LineItem> __UnsafeField_Items(Order obj);

// Usato durante la deserializzazione:
__UnsafeField_Items(entity) = deserializedItems; // una singola istruzione MOV
#else
// Fallback per target precedenti: FieldInfo cached in un campo statico
private static readonly FieldInfo _fi_Items =
    typeof(Order).GetField("_items",
        BindingFlags.Instance | BindingFlags.NonPublic)!;
// SetValue usato una volta per chiamata di deserializzazione — reflection, ma FieldInfo è cached
_fi_Items.SetValue(entity, deserializedItems);
#endif
```

Il percorso .NET 8 è genuinamente a zero overhead. Il percorso più vecchio usa ancora la reflection, ma l'oggetto `FieldInfo` è cached così il runtime non esegue mai un'altra ricerca di membro.

### Step 5: Nessuna lookup a dizionario durante la deserializzazione

Con la reflection fuori dai piedi, rimane ancora la questione di come un deserializzatore abbina i nomi dei campi BSON alle proprietà senza un dizionario. Il codice generato usa una semplice istruzione `switch`:

```csharp
switch (elementName)
{
    case "_id":   id     = reader.ReadObjectId(); break;
    case "name":  name   = reader.ReadString();   break;
    case "items": /* leggi array */ break;
    default:      reader.SkipValue(bsonType);     break;
}
```

Il compilatore C# (e il JIT) ottimizza le istruzioni `switch` su stringhe in dispatch basato su hash quando il numero di casi è abbastanza grande. Anche nel caso peggiore è una scansione lineare su pochi letterali — molto più veloce di una lookup su `Dictionary<string, PropertyInfo>` con i suoi nodi `DictionaryEntry` allocati sull'heap e il calcolo dell'hash.

---

## Parte II — Il Problema delle Allocazioni

### Perché le allocazioni contano in uno storage engine

Ogni volta che scrivi `new byte[4096]` il runtime alloca un oggetto sull'heap managed. Quando diventa irraggiungibile, il GC lo raccoglie. Per una tipica richiesta web questo va bene. Per uno storage engine che processa migliaia di letture e scritture al secondo, diventa latenza misurabile e memoria frammentata.

L'obiettivo in BLite non era eliminare tutte le allocazioni — impossibile nel codice managed. L'obiettivo era garantire che la *pipeline di serializzazione* stessa — lettura e scrittura di byte BSON grezzi — non allocasse nulla.

### `ref struct`: il writer che non può finire sull'heap

`BsonSpanWriter` e `BsonSpanReader` sono entrambi dichiarati come `ref struct`:

```csharp
public ref struct BsonSpanWriter
{
    private Span<byte> _buffer;
    private int _position;
    // ...
}
```

Un `ref struct` è, per garanzia del linguaggio, solo-stack. Non può essere boxato, non può essere memorizzato in un campo di una classe regolare, non può essere catturato da una lambda, e non può essere usato come argomento di tipo generico (prima di C# 13). Queste sembrano restrizioni, ma sono in realtà un contratto di sicurezza: il compilatore impedisce di spostare accidentalmente la struct sull'heap.

Tutte le operazioni di scrittura vanno direttamente nello `Span<byte>` fornito dal chiamante:

```csharp
public void WriteInt32(string name, int value)
{
    WriteElementHeader(BsonType.Int32, name);
    BinaryPrimitives.WriteInt32LittleEndian(_buffer.Slice(_position, 4), value);
    _position += 4;
}
```

`BinaryPrimitives.WriteInt32LittleEndian` scrive quattro byte direttamente nel buffer senza alcuna allocazione intermedia. Nessun `new byte[]`, nessun `MemoryStream`, nessun wrapper `BinaryWriter`.

### `BsonSpanReader`: letture zero-copy dalle pagine raw

Il reader funziona allo stesso modo in senso inverso. Mantiene uno `ReadOnlySpan<byte>` che punta direttamente al buffer di pagina che lo storage engine ha caricato da disco (o dalla sua cache in memoria):

```csharp
public ReadOnlySpan<byte> ReadBinary(out byte subtype)
{
    var length = ReadInt32();
    subtype = _buffer[_position++];
    var data = _buffer.Slice(_position, length); // slice zero-copy
    _position += length;
    return data;
}
```

`_buffer.Slice(...)` non copia i byte; crea un nuovo span che punta alla stessa memoria con un offset e una lunghezza diversi. Il chiamante legge dati binari senza mai allocare un `byte[]`.

### Il problema `ref struct` con i delegate

C'è una conseguenza scomoda delle regole `ref struct`: non puoi usare `Func<BsonSpanReader, T>` perché i tipi `ref struct` non possono essere argomenti di tipo generico prima di C# 13. BLite aggira questo problema definendo tipi delegate espliciti:

```csharp
// Definiti una volta; forniscono type safety senza vincoli generici
public delegate bool   BsonReaderPredicate(BsonSpanReader reader);
public delegate TResult? BsonReaderProjector<TResult>(BsonSpanReader reader);
```

Il commento nel sorgente è esplicito: *"BsonSpanReader is a ref struct; on targets older than .NET 9 / C# 13, ref structs cannot be used as generic type arguments. These non-generic delegates solve that constraint without sacrificing type safety."*

### `stackalloc` vs `ArrayPool` — lo strumento giusto per sync vs async

Lo stesso problema di allocazione del buffer appare nel WAL (Write-Ahead Log). Scrivere un record di inizio transazione richiede un buffer di 17 byte. Servono due soluzioni diverse a seconda del contesto:

**Percorso sincrono** — `stackalloc` alloca direttamente sullo stack delle chiamate. Quando la funzione ritorna, la memoria scompare. Zero pressione sul GC, zero codice di cleanup:

```csharp
private void WriteBeginRecordInternal(ulong transactionId)
{
    Span<byte> buffer = stackalloc byte[17];
    buffer[0] = (byte)WalRecordType.Begin;
    BitConverter.TryWriteBytes(buffer[1..9],  transactionId);
    BitConverter.TryWriteBytes(buffer[9..17], DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
    _walStream!.Write(buffer);
}
```

**Percorso asincrono** — `stackalloc` non può essere usato oltre un boundary `await` perché lo stack delle chiamate potrebbe essere diverso dopo che l'`await` riprende. `ArrayPool<byte>.Shared` prende in prestito un array pre-allocato da un pool thread-safe, lo usa per l'I/O, poi lo restituisce immediatamente:

```csharp
public async ValueTask WriteBeginRecordAsync(ulong txnId, CancellationToken ct = default)
{
    var buffer = ArrayPool<byte>.Shared.Rent(17);
    try
    {
        buffer[0] = (byte)WalRecordType.Begin;
        BitConverter.TryWriteBytes(buffer.AsSpan(1, 8),  txnId);
        BitConverter.TryWriteBytes(buffer.AsSpan(9, 8),
            DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
        await _walStream!.WriteAsync(new ReadOnlyMemory<byte>(buffer, 0, 17), ct);
    }
    finally
    {
        ArrayPool<byte>.Shared.Return(buffer); // ritorna al pool
    }
}
```

`ArrayPool` è la soluzione standard .NET per questo pattern. Gli array in prestito vivono in un pool segmentato per dimensione; `Rent(17)` tipicamente restituisce un array da 32 byte e lo mantiene fuori dall'heap per quanto riguarda il GC.

### `MemoryMarshal` per gli header di pagina: reinterpret, non copia

Gli header delle pagine di storage (`SlottedPageHeader`) sono struct C in spirito — mappano direttamente a una sequenza di byte su disco. `StructLayout(LayoutKind.Explicit)` fissa ogni campo a un offset di byte noto:

```csharp
[StructLayout(LayoutKind.Explicit, Size = 24)]
public struct SlottedPageHeader
{
    [FieldOffset(0)]  public uint   PageId;
    [FieldOffset(4)]  public PageType PageType;
    [FieldOffset(8)]  public ushort SlotCount;
    [FieldOffset(10)] public ushort FreeSpaceStart;
    // ...
}
```

Leggere un header da disco diventa un singolo cast di reinterpretazione — nessun parsing campo per campo, nessun oggetto intermedio:

```csharp
public static SlottedPageHeader ReadFrom(ReadOnlySpan<byte> source)
    => MemoryMarshal.Read<SlottedPageHeader>(source);
```

`MemoryMarshal.Read<T>` prende i primi `sizeof(T)` byte dello span e li reinterpreta come `T`. È l'equivalente managed di `*(SlottedPageHeader*)(buffer + offset)` in C. La scrittura funziona allo stesso modo in senso inverso con `MemoryMarshal.Write`.

---

## Cosa Non Mi Aspettavo

### C# è sorprendentemente vicino al metallo quando ne hai bisogno

Ho iniziato questo progetto pensando che il codice zero-allocation in C# significasse scendere in blocchi `unsafe` e puntatori pinned. Mi sbagliavo. `Span<T>`, `ref struct`, `stackalloc`, `ArrayPool` e `MemoryMarshal` coprono la maggior parte dei casi reali in modo pulito e sicuro. La pressione GC nel layer di serializzazione di BLite è quasi zero, e il codice è ancora leggibile da qualsiasi sviluppatore C# che conosce la libreria standard.

### `[UnsafeAccessor]` è un punto di svolta per i modelli DDD

Prima di .NET 8 il pattern backing-field DDD era un vero problema per ORM e serializzatori. O si costringevano gli utenti a usare setter pubblici, oppure si pagava il costo della reflection su ogni scrittura. `[UnsafeAccessor]` elimina questo tradeoff in modo netto — l'accesso viene risolto in JIT time e il codice risultante è veloce quanto un accesso diretto al campo.

### I source generator spostano il costo dove deve stare

Il guadagno più grande per il problema della reflection è stato capire che l'analisi dei tipi appartiene a compile time, non a runtime. I source generator non sono magici — sono semplicemente codice che gira sul syntax tree di Roslyn durante `dotnet build`. Ma permettono di scrivere il codice di ispezione lento e accurato una volta sola, emetterlo come C# statico, e non pagarlo mai più a runtime. I mapper generati sono trasparenti, debuggabili, e non producono sorprese durante l'avvio.

---

## La Strada Avanti

Ci sono ancora allocazioni nel layer di query che intendo affrontare. Il `BsonProjectionCompiler` crea un piccolo `object?[]` per ogni documento proiettato — evitabile con un `ref struct` enumerator e alcune tuple value-type. La priority queue nel traversal B-tree prende in prestito da `ArrayPool` ma potrebbe essere ulteriormente ottimizzata.

Detto questo, la pipeline di serializzazione principale — il percorso che ogni lettura e scrittura attraversa — non alloca nulla oltre all'entità stessa. Per un database .NET embedded, sembrava il posto giusto da cui iniziare.
