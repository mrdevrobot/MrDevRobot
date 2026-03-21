---
title: "Zero Alloc, Zero Reflection: How BLite Handles Complex Objects at Full Speed"
date: "2026-03-21"
description: "Two engineering challenges in BLite: supporting private fields, private constructors and nested collections without runtime reflection — and managing serialization buffers without putting pressure on the GC."
tags: [".net", "blite", "performance", "reflection", "span", "source-generators", "memory", "open-source"]
image: "/avatar.jpg"
---

When I started writing BLite I set two hard constraints for myself:

1. **No reflection on the hot path.** Every `Insert`, `Find`, or `Update` call had to be free of `MethodInfo.Invoke`, `PropertyInfo.SetValue`, and friends.
2. **No unnecessary heap allocations.** The serialization pipeline should never make the GC work harder than strictly necessary.

Both turned out to be harder than I expected. This post explains the techniques I ended up with, and the specific problems that pushed me toward each one.

---

## Part I — The Reflection Problem

### Why reflection is hard to avoid

A serialization library needs to do two things that normally require reflection: *create an instance of a type it has never seen before*, and *set properties on that instance*. The obvious approach is:

```csharp
var entity = Activator.CreateInstance(typeof(OrderEntity));
typeof(OrderEntity).GetProperty("Status")!.SetValue(entity, value);
```

This works for 90% of real-world types. It breaks silently for the other 10%:

- **Private constructors** — DDD aggregates often seal their constructors to enforce invariants.
- **`init`-only setters** — popular since C# 9, impossible to call via `PropertyInfo.SetValue` after construction.
- **Private backing fields** — when you expose `IReadOnlyCollection<T>` but store `List<T>` internally, the property setter simply doesn't exist.
- **Performance** — even with caching, `PropertyInfo.SetValue` boxes value types and adds method dispatch overhead on every call.

### Step 1: Move the analysis to compile time

The first insight was that reflection is only painful *at runtime*. If I could do all the type inspection at compile time and generate plain C# code, the runtime would see nothing but ordinary method calls and field assignments.

BLite uses a **Roslyn Source Generator** (`IIncrementalGenerator`) that runs during compilation. It walks every class referenced by a `DocumentDbContext`, inspects its members via Roslyn's `INamedTypeSymbol` API, and emits a concrete mapper class:

```csharp
// Executed at compile time — zero cost at runtime
var hasPublicParameterlessCtor = entityType.Constructors
    .Any(c => c.DeclaredAccessibility == Accessibility.Public
              && c.Parameters.Length == 0);

entityInfo.HasPrivateOrNoConstructor = !hasPublicParameterlessCtor;

// Find the DDD backing field: _propertyName
conventionalBackingField = SyntaxHelper.FindConventionalBackingField(prop);
```

The generator knows, at build time, which properties have private setters, whether the constructor is accessible, and whether there is a backing field to worry about.

### Step 2: Expression Trees for private setters and `init`-only properties

For properties that have a setter — even a private or `init`-only one — the generated mapper creates a compiled `Action<TObj, TVal>` delegate during type initialization (the first time the static class is loaded), and caches it in a `static readonly` field:

```csharp
// Generated code — executed once per appdomain lifetime
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

`Expression.Lambda(...).Compile()` produces real IL — the same IL that the C# compiler would have emitted if the setter were public. At runtime, calling `_setter_Status(entity, "shipped")` is indistinguishable in cost from calling a normal public setter.

The compilation happens *once*, when the `static readonly` field is initialized. After that, every deserialization call pays nothing.

### Step 3: `RuntimeHelpers.GetUninitializedObject` for private constructors

What about types with no accessible constructor at all? The generated mapper uses `RuntimeHelpers.GetUninitializedObject` to bypass the constructor entirely:

```csharp
// Generated deserialization code
var entity = (OrderEntity)
    RuntimeHelpers.GetUninitializedObject(typeof(OrderEntity));

// Properties are then set via compiled delegates:
_setter_Status(entity, status ?? default!);
entity.Name = name ?? default!;
```

`GetUninitializedObject` allocates the managed object and zeroes its memory without invoking any constructor. This is the same mechanism the .NET runtime uses internally for deserialization. It is safe as long as you correctly initialize all fields afterward — which the generated mapper does, having been built with full knowledge of the type's members.

### Step 4: `[UnsafeAccessor]` for private backing fields (NET 8+)

The trickiest case is the DDD pattern where a collection is stored as a private `List<T>` but exposed as `IReadOnlyCollection<T>`. There is no setter, and the backing field has a mangled name:

```csharp
public class Order
{
    private readonly List<LineItem> _items = new();
    public IReadOnlyCollection<LineItem> Items => _items.AsReadOnly();
}
```

On .NET 8 and later, the generator emits an `[UnsafeAccessor]` attribute — a feature that lets you reference a private member by name with *zero overhead* at runtime. The JIT resolves it to a direct field access, no reflection involved:

```csharp
#if NET8_0_OR_GREATER
[UnsafeAccessor(UnsafeAccessorKind.Field, Name = "_items")]
private static extern ref List<LineItem> __UnsafeField_Items(Order obj);

// Used during deserialization:
__UnsafeField_Items(entity) = deserializedItems; // one MOV instruction
#else
// Fallback for older targets: FieldInfo cached in a static field
private static readonly FieldInfo _fi_Items =
    typeof(Order).GetField("_items",
        BindingFlags.Instance | BindingFlags.NonPublic)!;
// SetValue used once per deserialization call — reflection, but FieldInfo is cached
_fi_Items.SetValue(entity, deserializedItems);
#endif
```

The .NET 8 path is genuinely zero-overhead. The older path still uses reflection, but the `FieldInfo` object is cached so the runtime never performs another member lookup.

### Step 5: No dictionary lookup during deserialization

With reflection out of the way, there is still the question of how a deserializer matches BSON field names to properties without a dictionary. The generated code uses a plain `switch` statement:

```csharp
switch (elementName)
{
    case "_id":   id     = reader.ReadObjectId(); break;
    case "name":  name   = reader.ReadString();   break;
    case "items": /* read array */ break;
    default:      reader.SkipValue(bsonType);     break;
}
```

The C# compiler (and the JIT) optimizes string `switch` statements into hash-based dispatch when the number of cases is large enough. Even in the worst case it is a linear scan over a handful of literals — far faster than a `Dictionary<string, PropertyInfo>` lookup with its heap-allocated `DictionaryEntry` nodes and hash computation.

---

## Part II — The Allocation Problem

### Why allocations matter in a storage engine

Every time you call `new byte[4096]` the runtime allocates an object on the managed heap. When it becomes unreachable, the GC eventually collects it. For a typical web request this is fine. For a storage engine that processes thousands of reads and writes per second, it becomes measurable latency and fragmented memory.

The goal in BLite was not to eliminate all allocations — that is impossible in managed code. The goal was to ensure that the *serialization pipeline* itself — reading and writing raw BSON bytes — allocated nothing.

### `ref struct`: the writer that cannot escape to the heap

`BsonSpanWriter` and `BsonSpanReader` are both declared as `ref struct`:

```csharp
public ref struct BsonSpanWriter
{
    private Span<byte> _buffer;
    private int _position;
    // ...
}
```

A `ref struct` is, by language guarantee, stack-only. It cannot be boxed, cannot be stored in a field of a regular class, cannot be captured by a lambda, and cannot be used as a generic type argument (before C# 13). These look like restrictions, but they are actually a safety contract: the compiler prevents you from accidentally moving the struct to the heap.

All write operations go directly to the `Span<byte>` that the caller provides:

```csharp
public void WriteInt32(string name, int value)
{
    WriteElementHeader(BsonType.Int32, name);
    BinaryPrimitives.WriteInt32LittleEndian(_buffer.Slice(_position, 4), value);
    _position += 4;
}
```

`BinaryPrimitives.WriteInt32LittleEndian` writes four bytes directly into the buffer without any intermediate allocation. There is no `new byte[]`, no `MemoryStream`, no `BinaryWriter` wrapper.

### `BsonSpanReader`: zero-copy reads from raw pages

The reader works the same way in reverse. It holds a `ReadOnlySpan<byte>` pointing directly at the page buffer that the storage engine loaded from disk (or from its in-memory cache):

```csharp
public ReadOnlySpan<byte> ReadBinary(out byte subtype)
{
    var length = ReadInt32();
    subtype = _buffer[_position++];
    var data = _buffer.Slice(_position, length); // zero-copy slice
    _position += length;
    return data;
}
```

`_buffer.Slice(...)` does not copy bytes; it creates a new span that points into the same memory with a different start and length. The caller reads binary data without ever allocating a `byte[]`.

### The `ref struct` problem with delegates

There is an annoying consequence of `ref struct` rules: you cannot use `Func<BsonSpanReader, T>` because `ref struct` types cannot be generic type arguments before C# 13. BLite works around this by defining explicit delegate types:

```csharp
// Defined once; provides type safety without generic constraints
public delegate bool   BsonReaderPredicate(BsonSpanReader reader);
public delegate TResult? BsonReaderProjector<TResult>(BsonSpanReader reader);
```

The comment in the source is clear: *"BsonSpanReader is a ref struct; on targets older than .NET 9 / C# 13, ref structs cannot be used as generic type arguments. These non-generic delegates solve that constraint without sacrificing type safety."*

### `stackalloc` vs `ArrayPool` — the right tool for sync vs async

The same buffer-allocation problem appears in the WAL (Write-Ahead Log). Writing a transaction begin record requires a 17-byte buffer. Two different solutions are needed depending on context:

**Synchronous path** — `stackalloc` allocates directly on the call stack. When the function returns, the memory is gone. Zero GC pressure, zero cleanup code:

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

**Asynchronous path** — `stackalloc` cannot be used across an `await` boundary because the call stack may be different after the `await` resumes. `ArrayPool<byte>.Shared` rents a pre-allocated array from a thread-safe pool, uses it for the I/O, then returns it immediately:

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
        ArrayPool<byte>.Shared.Return(buffer); // back to the pool
    }
}
```

`ArrayPool` is the standard .NET solution for this pattern. Rented arrays live in a pool segmented by size; `Rent(17)` will typically return a 32-byte array and keep it off the heap as far as the GC is concerned.

### `MemoryMarshal` for page headers: reinterpret, not copy

Storage page headers (`SlottedPageHeader`) are plain C structs in spirit — they map directly to a sequence of bytes on disk. `StructLayout(LayoutKind.Explicit)` pins every field at a known byte offset:

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

Reading one from disk becomes a single reinterpret cast — no field-by-field parsing, no intermediate objects:

```csharp
public static SlottedPageHeader ReadFrom(ReadOnlySpan<byte> source)
    => MemoryMarshal.Read<SlottedPageHeader>(source);
```

`MemoryMarshal.Read<T>` takes the first `sizeof(T)` bytes of the span and reinterprets them as `T`. It is the managed-code equivalent of C's `*(SlottedPageHeader*)(buffer + offset)`. Writing works the same way in reverse with `MemoryMarshal.Write`.

---

## What I Did Not Expect

### C# is surprisingly close to the metal when you need it to be

I came into this project thinking that zero-allocation code in C# meant dropping into `unsafe` blocks and pinned pointers. I was wrong. `Span<T>`, `ref struct`, `stackalloc`, `ArrayPool`, and `MemoryMarshal` cover most real-world cases cleanly and safely. The GC pressure in BLite's serialization layer is near zero, and the code is still readable by any C# developer who knows the standard library.

### `[UnsafeAccessor]` is a game-changer for DDD models

Before .NET 8 the DDD backing-field pattern was a genuine pain for ORMs and serializers. You either forced users to use public setters, or you paid the reflection tax on every write. `[UnsafeAccessor]` eliminates that tradeoff cleanly — the access is resolved at JIT time and the resulting code is as fast as a direct field access.

### Source generators shift the cost to where it belongs

The single biggest win for the reflection problem was realizing that type analysis belongs at compile time, not runtime. Source generators are not magical — they are just code that runs on the Roslyn syntax tree during `dotnet build`. But they let you write the slow, careful inspection code once, emit it as static C#, and never pay for it again at runtime. The generated mappers are transparent, debuggable, and produce no surprises during startup.

---

## The Road Ahead

There are still allocations in the query layer that I plan to address. The `BsonProjectionCompiler` creates a small `object?[]` for each projected document — avoidable with a `ref struct` enumerator and some value-type tuples. The priority queue in the B-tree traversal rents from `ArrayPool` but could be further refined.

That said, the core serialization pipeline — the path every read and write goes through — allocates nothing beyond the entity itself. For an embedded .NET database, that felt like the right place to start.
