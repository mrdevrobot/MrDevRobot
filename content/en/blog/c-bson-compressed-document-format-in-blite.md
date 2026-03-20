---
title: "C-BSON: The Compressed Document Format I Built Into BLite"
description: "Why I replaced BSON's null-terminated field names with 2-byte integer IDs, how the dictionary system works, and an honest critique of the trade-offs I made."
date: "2026-03-20"
tags: [".net", "blite", "bson", "embedded-database", "performance", "open-source", "storage-engine"]
---

# C-BSON: The Compressed Document Format I Built Into BLite

This is the first of what I hope will be a series of deep-dives into BLite — the embedded document database I've been building from scratch for .NET. Today I want to talk about one of the most foundational decisions in the whole project: **why I stopped using standard BSON and built a custom format, which I call C-BSON** ("Compressed BSON").

Fair warning: this won't be a victory lap. I'll show real code, explain the motivations, and then critically examine the choices — because if you're taking the time to read this, you deserve the full picture, not a marketing brochure.

---

## The Problem with Standard BSON

[BSON](https://bsonspec.org/) is the wire format behind MongoDB. It's a perfectly reasonable design: a compact binary representation of JSON-like documents. Each element in a BSON document is serialized as:

```
[1 byte: type] [N bytes: field name as null-terminated UTF-8] [N bytes: value]
```

Here's the problem: the field name is stored **verbatim in every single document**. Every document. Every record on disk.

Let's make this concrete. Imagine a collection of user profiles with fields like `email`, `username`, `created_at`, `last_login`, `subscription_tier`. In a 100,000-document collection, the field name `subscription_tier` (17 bytes + null) is written to disk **one hundred thousand times**. That's 1.8 MB of field names alone, carrying zero information beyond the first instance.

For embedded databases — where you're optimizing for a constrained environment and your data has a known, stable schema — this is a significant waste. You pay it in:
- **Storage space** (larger database files)
- **I/O bandwidth** (more bytes to read per document)
- **Serialization cost** (memcpy of field names on every write)

The standard mitigation in document databases is compression (LZ4, Snappy, Zstd). That works, but it adds CPU overhead on every read/write, and the gains are partial. I wanted to attack the problem at the source.

---

## The C-BSON Idea: A Shared Field Dictionary

The insight is straightforward: if all documents in a collection share the same field names, why not store the field names **once** and refer to them by a short integer ID?

C-BSON replaces the null-terminated UTF-8 field name with a **2-byte `ushort` field ID**. The field names live in a **database-level dictionary** — a bidirectional map between `string` and `ushort` — persisted on disk and warm-cached in memory.

The element wire format becomes:

```
[1 byte: type] [2 bytes: field ID as little-endian ushort] [N bytes: value]
```

That's a **fixed 3-byte element header**, regardless of how long the field name is.

Let's revisit the concrete savings. For a typical set of user profile fields:

| Field name       | Standard BSON (bytes) | C-BSON (bytes) | Savings |
|------------------|-----------------------|----------------|---------|
| `email`          | 6                     | 2              | 67%     |
| `username`       | 9                     | 2              | 78%     |
| `created_at`     | 11                    | 2              | 82%     |
| `last_login`     | 11                    | 2              | 82%     |
| `subscription_tier` | 18                 | 2              | 89%     |

Across a realistic document schema, this reduces total document size by **30–60%** depending on field name verbosity versus value payload.

### Reserved IDs (0–100)

IDs 0–100 are reserved for system fields: `_id`, `_v` (version), `_t` (type discriminator), and others that BLite uses internally. User fields start from ID 101. This is important for schema stability: system fields always have deterministic IDs regardless of insertion order.

---

## The Dictionary System

The dictionary is managed by `StorageEngine.Dictionary.cs`. It does three things:

1. **Persists** field names and their IDs to a chain of `DictionaryPage` records on disk
2. **Warm-caches** the full map in memory after load
3. **Registers new fields** thread-safely when an unknown field is first seen

The core method is `GetOrAddDictionaryEntry`:

```csharp
public ushort GetOrAddDictionaryEntry(string key)
{
    key = key.ToLowerInvariant(); // all field names are case-insensitive

    // Fast path: hit the in-memory cache
    if (_dictionaryCache.TryGetValue(key, out var id)) return id;

    // Slow path: need to allocate a new ID and persist it
    lock (_dictionaryLock)
    {
        // Double-check after acquiring the lock
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

A few things worth noting here:

**Double-checked locking** is used correctly. The `ConcurrentDictionary` fast path avoids the lock on every field access. New fields are rare after the first few inserts, so this is essentially lock-free in steady state.

**`ToLowerInvariant()` is called before the cache lookup.** This is a deliberate design choice: all C-BSON field names are normalized to lowercase at registration time. That means `Email`, `EMAIL`, and `email` all map to the same dictionary entry. This is convenient — it handles inconsistencies from different serializers — but it has implications I'll revisit in the critique section.

**`InsertDictionaryEntryGlobal`** writes the new mapping to disk before updating the in-memory caches. If the process crashes mid-write, the new ID never makes it into the cache, and the next startup re-reads from disk into a clean state.

At startup, BLite pre-registers a set of system keys to ensure stable IDs:

```csharp
RegisterKeys(new[] { "_id", "t", "_v", "f", "n", "b", "s", "a" });
```

These are the primitive BSON building blocks used in BLite's own internal data structures.

---

## BsonSpanWriter: Zero Allocation on the Write Path

The serializer is `BsonSpanWriter`, a `ref struct` that writes directly onto a caller-provided `Span<byte>`. Because it's a `ref struct`, it can hold a `Span<byte>` as a field without any heap allocation. The entire serialization of a document happens without touching the GC.

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

The heart of the format is `WriteElementHeader`:

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

Three bytes written. No null terminator scan, no memcpy of the field name string, no bounds check beyond the span slice. `BinaryPrimitives.WriteUInt16LittleEndian` is a BCL intrinsic — on x64 it compiles down to a single `mov` instruction.

### Two-Pass Document Size Writing

BSON documents start with a 4-byte document size, which you don't know until you've written all the elements. C-BSON uses the same two-pass technique as standard BSON:

```csharp
// Phase 1: reserve 4 bytes for the size
public int WriteDocumentSizePlaceholder()
{
    var offset = _position;
    _position += 4;
    return offset; // returns where to patch later
}

// Phase 2: go back and fill in the actual size
public void PatchDocumentSize(int offset)
{
    var size = _position - offset;
    BinaryPrimitives.WriteInt32LittleEndian(_buffer.Slice(offset, 4), size);
}
```

The caller saves the offset from `WriteDocumentSizePlaceholder`, writes all elements, then calls `PatchDocumentSize` with the saved offset. Simple.

---

## BsonSpanReader: Deserialization and the Reverse Map

The reader, `BsonSpanReader`, is the symmetric counterpart — also a `ref struct` on `ReadOnlySpan<byte>`. For element headers, instead of looking up `string → ushort`, it does the reverse: `ushort → string`.

```csharp
public ref struct BsonSpanReader
{
    private ReadOnlySpan<byte> _buffer;
    private int _position;
    private readonly ConcurrentDictionary<ushort, string> _keys; // reverse map
}
```

Reading an element header:

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

Both caches — `_keyMap` in the writer and `_keys` in the reader — are injected at construction time and shared with the storage engine. There's no per-call dictionary allocation.

### Type Coercion

BLite Studio (the GUI tool for BLite) needs to read documents in a schema-less manner without knowing field types in advance. Rather than requiring an exact type match, the reader offers coercion helpers:

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

There's also `ReadInt64Coerced` with the same pattern. These exist so that BLite Studio can render a column as "number" regardless of whether individual documents stored the field as `Int32`, `Int64`, or `Double`. This is a pragmatic concession to the reality of schema-less tooling.

---

## Two Interesting Quirks Worth Discussing Openly

### 1. Array Indices Bypass the Dictionary

Here's something I chose to keep from standard BSON instead of extending C-BSON's ID scheme: **array element keys still use raw ASCII strings**.

In BSON, arrays are encoded as sub-documents where the keys are the string representations of the indices: `"0"`, `"1"`, `"2"`, etc. In C-BSON, those are written as literal ASCII bytes too, not dictionary IDs.

The most visible example is in `WriteCoordinates`, the optimized path for GIS coordinate pairs:

```csharp
// Writing array element "0" — raw ASCII, not a dictionary ID
_buffer[_position++] = (byte)BsonType.Double;
_buffer[_position++] = 0x30; // ASCII '0'
_buffer[_position++] = 0x00; // null terminator (standard CString style!)

// Writing array element "1"
_buffer[_position++] = (byte)BsonType.Double;
_buffer[_position++] = 0x31; // ASCII '1'
_buffer[_position++] = 0x00;
```

Notice: this is the **CString null-terminated format**, not the 3-byte C-BSON header. The reader has a corresponding `SkipArrayKey()` method that skips the CString-formatted array index.

Is this a problem? For most workloads, no — array indices are short (`"0"` is 2 bytes including the null, vs 2 bytes for a dictionary ID), so there's no meaningful size difference. And for `WriteCoordinates` specifically, the function is hyper-optimized for `(double, double)` geo pairs: the entire inline implementation avoids any dynamic dispatch or generic path.

But **it is a design inconsistency.** The format now has two modes: dictionary IDs for document fields, raw CStrings for array indices. A parser must know which context it's in to decode correctly. I consider this an acceptable trade-off today, but it's on my list to revisit if I ever define a full array element dictionary (which would benefit collections with deeply nested array-of-object patterns).

### 2. Decimal128 Is Not IEEE 754-2008 Compliant

The `WriteDecimal128` method stores C#'s `decimal` type using its native bit representation:

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

C#'s `decimal.GetBits()` returns four `int` values in a layout specific to the CLR — sign, scale, and 96-bit mantissa — which is **not the same** as the 128-bit IEEE 754-2008 Decimal128 format used by standard BSON, MongoDB, and most other implementations.

The comment in the source code is honest about this: it's a deliberate choice trading standard interoperability for perfect round-trip fidelity within BLite. A value like `1.23456789012345678901234567890m` that pushes .NET `decimal`'s 28-digit precision will survive a round-trip through BLite intact — but the bytes on disk are meaningless to a standard BSON reader.

**This matters** if you ever want to export a BLite database to another system that reads standard BSON. It would require a conversion step. BLite is an embedded database for .NET applications, not a drop-in MongoDB replacement, so I consider this trade-off defensible — but you should know it exists.

### 3. Case-Insensitive Field Names

The `ToLowerInvariant()` call in `GetOrAddDictionaryEntry` means that once a field named `Email` is registered, there is no field named `email` separate from it — they are the same entry. This simplifies life when consuming data from different sources. However:

- An object with a property `Email` and one with `email` will map to the same dictionary ID. If you're reading documents that were written with different casing by different producers, they'll all resolve to the same field. This might be what you wanted — or it might silently hide a bug in your producer code.
- `ToLowerInvariant` is called **on every cache miss**, which means every new field registration goes through a string allocation. The cost is amortized over the life of the database, but it's worth noting in contexts where field names are extremely dynamic.

### 4. Fail-Fast on Unregistered Keys

`WriteElementHeader` throws on an unknown key:

```csharp
if (!_keyMap.TryGetValue(name, out var id))
    throw new InvalidOperationException(
        $"BSON Key '{name}' not found in dictionary cache.");
```

This means you **must** call `GetOrAddDictionaryEntry` before calling the writer. In BLite's normal usage, the source-generated serializer handles this automatically at compile time. But if you're writing custom serialization code against the low-level API, it's easy to get an `InvalidOperationException` at runtime instead of a compile-time error.

An alternative design would be to auto-register the key inline. I chose fail-fast because I want the dictionary registration — a write to disk — to be explicit and auditable, separate from the hot serialization path. Whether that's the right call is debatable; I lean toward "yes" because disk writes in a hot serialization path are a footgun.

---

## The Numbers

These benchmarks were run on Windows 11, Intel Core i7-13800H, .NET 10.0.4 (March 2026). Full methodology is in [BENCHMARKS.md](https://github.com/EntglDb/BLite/blob/main/BENCHMARKS.md).

**BLite vs LiteDB**

| Operation | BLite | LiteDB | ×faster |
|---|---|---|---|
| Single insert | 164.6 μs | 820 μs | 5.0× |
| Batch insert (1k docs) | 14,086 μs | 26,760 μs | 1.9× |
| FindById | 3.98 μs | 22.4 μs | 5.6× |
| Full scan (100k docs) | 2,502 μs | 8,500 μs | 3.4× |

**BLite vs SQLite+JSON / DuckDB**

| Operation | BLite | SQLite+JSON | DuckDB |
|---|---|---|---|
| Single insert | 164.6 μs | 7,400 μs | — |
| FindById | 3.98 μs | 38.2 μs | 11,304 μs |
| Full scan (100k docs) | 2,502 μs | 8,000 μs | — |

Allocation after WAL page buffer reuse (March 2026): batch insert **64 MB → 31 MB** (−51%).

Serialization in isolation (10k docs): **42% faster than `System.Text.Json`**. Single document: **2.4× faster**.

These numbers are competitive, and C-BSON is a material contributor. Smaller documents mean fewer bytes through the serializer, fewer bytes to write through the WAL, and fewer bytes to read back during scans.

---

## Honest Critique: What Doesn't Work Yet

Let me be clear about the current limitations:

**1. No multi-process access.** Current BLite opens the database file with `FileShare.None`. The in-memory dictionary cache is authoritative after load because no other process can write to it concurrently. This is fine for most embedded scenarios, but it rules out use cases like running BLite alongside a separate analytics process. The dictionary cache invalidation story becomes non-trivial once you lift this constraint.

**2. The ushort ceiling.** Dictionary IDs are `ushort`, giving 65,535 distinct field names (with 0–100 reserved). For most structured data this is far more than enough. But if you're storing highly dynamic documents — think event sourcing with arbitrary metadata keys, or IoT telemetry with variable sensor names — you could approach this limit in a large enough deployment. The fix is straightforward (switch to `uint`), but it's a breaking storage format change.

**3. Schema dictionary is global, not per-collection.** All collections in a BLite database share a single field dictionary. This means field IDs are stable across collections, which has the pleasant side effect that documents in different collections can reference each other's field IDs without confusion. But it also means a field named `value` in your user collection and a field named `value` in your sensor collection both map to the same ID — fine, but slightly surprising.

**4. The array index inconsistency** (discussed above) means format parsers need to be context-aware. This is a latent complexity that I'd like to eliminate.

---

## What's Coming Next for C-BSON

The specification document (`C-BSON.md` in the repo) notes a few planned extensions:

- **Schema evolution metadata** — `BsonSchema` already supports versioning with hash fingerprints; the plan is to leverage schema versions for automatic lazy migration on read-modify-write cycles, so old documents silently upgrade to new schemas without a full collection scan.
- **Potential extension of the ID space** — if the ushort ceiling proves limiting, a flag byte could signal an extended 4-byte ID for overflow.
- **Array element IDs** — applying the same dictionary approach to array sub-document fields (not just top-level document fields).

---

## The Full Picture

C-BSON is one of the most impactful decisions in BLite's architecture. It's the reason why a `FindById` that might spend 10 microseconds deserializing a document in standard BSON takes under 4 microseconds in BLite. It's also the reason why BLite databases are significantly smaller on disk than equivalent LiteDB or SQLite+JSON stores.

But it comes with real trade-offs:
- You can't read a C-BSON file with a standard BSON parser.
- Decimal128 values are not wire-compatible with MongoDB or any tool that expects IEEE 754-2008.
- Single-process exclusive access is currently a hard constraint.
- The format favors structured, known-schema workloads over arbitrary document shapes.

Were these the right calls? For BLite's target use case — a high-performance embedded .NET database for structured data — I think yes, mostly. The interoperability trade-offs are acceptable because BLite isn't trying to be a MongoDB replacement; it's trying to be the fastest embedded document store in .NET.

But I'm sharing this openly because I'm curious what the community thinks. Are there scenarios where you'd want C-BSON compatibility with an external format? Is the `ushort` ceiling a real concern for you? Is the Decimal128 non-compliance a blocker?

The source is at [github.com/EntglDb/BLite](https://github.com/EntglDb/BLite). All of the code I've referenced here is in `src/BLite.Bson/` and `src/BLite.Core/Storage/`. I'd genuinely rather know about problems with these choices now, before the storage format is widely adopted, than later.

Pull requests and issues welcome.
