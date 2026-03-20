---
title: "Hello World — Why I Started This Blog"
description: "An introduction to MrDevRobot: my personal space for architecture deep-dives, open source stories, and technical writing."
date: "2026-03-20"
tags: [".net", "architecture", "open-source", "ddd"]
---

# Hello World — Why I Started This Blog

My name is **Luca Fabbri**. I'm a Computer Engineer (class of 2010), currently working as Tech Lead at **Zucchetti Hospitality Srl**, and an active open source developer.

This is **MrDevRobot** — my corner of the internet for exploring the things I care most about as an engineer.

## What this blog is about

I spend a lot of time thinking about how software is built — not just *what* it does, but *why* it's structured the way it is. Every non-trivial project involves dozens of decisions that never make it into a README.

This blog exists to capture those decisions:

- **Architectural choices** behind my open source projects
- **Technical deep-dives** into .NET, distributed systems, and Clean Architecture
- **Patterns and principles** I rely on daily: DDD, CQRS, Event-Driven architecture, the Saga pattern
- **Lessons from production** as a Tech Lead working on hospitality software at scale

## My open source work

Over the years I've built several libraries that scratch real itches:

- **[BLite](https://github.com/EntglDb/BLite)** — A high-performance, ACID-compliant, zero-allocation embedded document database for .NET, built from scratch. It features a full LINQ provider, vector search (HNSW), geospatial indexing (R-Tree), CDC, native time series, and compile-time source-generated serialization.

- **[EntglDb](https://github.com/EntglDb/EntglDb.Net)** — A P2P data synchronization middleware for .NET. It plugs into your existing database via Change Data Capture and enables automatic mesh-network replication with hash-chained oplogs, vector clocks, and pluggable conflict resolution.

- **[Concordia.Core](https://github.com/mrdevrobot/Concordia)** — A lightweight mediator for .NET, born as a free open source alternative to MediatR. Handler registration happens entirely at compile-time via Roslyn Source Generators — zero reflection, zero startup overhead.

- **[ProjectR](https://github.com/mrdevrobot/ProjectR)** — Object-to-object mapping with zero runtime reflection. Source-generated, AOT-compatible, fully transparent and debuggable.

- **[TransactR](https://github.com/mrdevrobot/TransactR)** — A .NET library for building reliable multi-step operations using the Memento and Saga patterns, with pluggable persistence backends and configurable rollback policies.

Each of these projects has a story — design decisions, dead ends, and "aha" moments. I'll be unpacking them here.

## Community

I'm a member of **[XeDotNet](https://xedotnet.org)**, the Veneto .NET developer community. A great group of people passionate about software craftsmanship and the .NET ecosystem.

---

Stay tuned. There's a lot to talk about.
