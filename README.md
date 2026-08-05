# DistriCache

**A distributed in-memory key-value cache, built from scratch.**

No frameworks. No Redis wrapper. Just raw TCP sockets, a custom wire protocol, consistent hashing, and the classic data structures that make caches fast — implemented from first principles in Node.js.

```
$ telnet localhost 7000

> PING
+PONG

> SET user:1 "alice" EX 60
+OK

> GET user:1
$5
alice

> DEL user:1
:1

> GET user:1
$-1
```

---

## Why Build This?

Caches are everywhere — they sit behind nearly every high-traffic system. But most developers only ever *use* them (call `redis.set()`), never *build* one. This project exists to answer the questions that come up in systems design interviews:

- **How does an LRU cache actually work?** → HashMap + doubly linked list for O(1) everything
- **What happens when you shard across nodes?** → Consistent hashing with virtual nodes
- **Why not just `hash(key) % N`?** → Because adding one node remaps nearly every key
- **How do you detect a dead node?** → Client-side PING health checks with a state machine
- **Why a custom protocol instead of HTTP?** → Lower overhead, direct TCP control, and protocol design is itself a learning goal

Every design choice in DistriCache is documented with its trade-offs — nothing is hidden behind "it just works."

---

## Architecture

DistriCache has three layers, each independently testable:

```
┌─────────────────────────────────────────────────────────────┐
│                      Client Library                         │
│   ┌─────────────┐  ┌──────────────┐  ┌───────────────────┐ │
│   │  Hash Ring   │  │  Conn Pool   │  │  Health Checker   │ │
│   │  (routing)   │  │  (TCP reuse) │  │  (PING/PONG)      │ │
│   └──────┬──────┘  └──────┬───────┘  └───────┬───────────┘ │
└──────────┼─────────────────┼──────────────────┼─────────────┘
           │                 │                  │
     ┌─────▼─────┐    ┌─────▼─────┐     ┌──────▼────┐
     │  Node A    │    │  Node B    │     │  Node C   │
     │  :7000     │    │  :7001     │     │  :7002    │
     └───────────┘    └───────────┘     └───────────┘

Each node is identical and topology-unaware.
All routing and failure detection lives in the client.
```

| Layer | What it does |
|---|---|
| **Cache Node** | TCP server → command parser → in-memory store (HashMap + LRU list) + TTL expiry |
| **Client Library** | Consistent hash ring routing, connection pooling, PING-based failure detection |
| **Tooling** | Benchmark client, Docker Compose orchestration |

---

## Data Structures

### The O(1) LRU Cache

The classic interview data structure: a **HashMap** for constant-time key lookup paired with a **doubly linked list** for constant-time recency tracking and eviction.

```
  Map<key, Node>            Doubly Linked List

  "user:1" → ●──────→   HEAD ↔ user:3 ↔ user:1 ↔ user:2 ↔ TAIL
  "user:2" → ●──────→              ↑                  ↑
  "user:3" → ●──────→              MRU               LRU
                                                 (evict this one)
```

| Operation | Time | What happens |
|---|---|---|
| `GET key` | O(1) | HashMap lookup → move node to front → return value |
| `SET key value` | O(1) | Insert/update → move to front → evict from tail if at capacity |
| `DEL key` | O(1) | HashMap delete → unlink node from list |
| Evict LRU | O(1) | Remove node before tail sentinel → delete from HashMap |

The linked list uses **sentinel nodes** (dummy head/tail) to eliminate null-pointer edge cases — the same technique Redis uses internally.

---

## Wire Protocol

A custom **text protocol over raw TCP** — deliberately not HTTP, not binary. Designed to be human-readable (testable via `telnet`) while structured enough for programmatic parsing.

### Request Format

```
COMMAND arg1 arg2 ... argN\r\n
```

- Commands are case-insensitive (`ping` = `PING` = `Ping`)
- String values with spaces use double quotes: `"hello world"`
- Each request is one line terminated by `\r\n`

### Response Format

| Prefix | Meaning | Example |
|---|---|---|
| `+` | Simple string (success) | `+OK\r\n` |
| `-` | Error | `-ERR unknown command\r\n` |
| `$` | Bulk string (value) | `$5\r\nalice\r\n` |
| `$-1` | Null (cache miss) | `$-1\r\n` |
| `:` | Integer | `:1\r\n` |

### Commands

| Command | Description | Response |
|---|---|---|
| `SET key value [EX seconds]` | Store a value with optional TTL | `+OK` |
| `GET key` | Retrieve a value | `$<len>\r\n<value>` or `$-1` |
| `DEL key` | Delete a key | `:<count>` |
| `PING` | Health check | `+PONG` |
| `EXPIRE key seconds` | Set TTL on existing key | `:1` or `:0` |
| `INFO` | Node statistics | Multi-line stats |

### Why text instead of binary?

| | Text (chosen) | Binary (e.g., full RESP) |
|---|---|---|
| **Debuggability** | ✅ `telnet` directly | ❌ Needs tooling |
| **Parse speed** | Slower (string splitting) | Faster (length-prefixed) |
| **Implementation** | Simpler | More complex |

Text wins here because **debuggability during development and demos outweighs parse speed** at this project's scale. A binary protocol variant is documented as a v2 extension.

---

## Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) v18+ (uses ES modules)
- [Docker](https://www.docker.com/) (optional, for multi-node cluster)

### Run a single node

```bash
git clone https://github.com/Touseef4002/DistriCache.git
cd DistriCache
npm install

node src/server.js
# → DistriCache node "node-7000" listening on port 7000
```

Then connect:

```bash
# Linux/macOS
telnet localhost 7000

# Windows (PowerShell)
# Use ncat, PuTTY, or any TCP client
ncat localhost 7000
```

### Run tests

```bash
npm test
# → 52 tests passing across 3 test suites
```

### Configuration

All via environment variables — no config files:

| Variable | Default | Description |
|---|---|---|
| `PORT` | `7000` | TCP port |
| `NODE_ID` | `node-<port>` | Identifier for logging |
| `MAX_ENTRIES` | `10000` | LRU cache capacity |
| `LOG_LEVEL` | `info` | `debug` / `info` / `warn` / `error` |

```bash
PORT=8000 NODE_ID=cache-1 MAX_ENTRIES=5000 node src/server.js
```

---

## Project Structure

```
DistriCache/
├── src/
│   ├── server.js            # TCP server, command dispatch, response formatting
│   ├── parser.js            # Wire protocol parser (stream buffering, quoted strings)
│   ├── store.js             # HashMap + LRU list (the O(1) cache)
│   ├── lru.js               # Doubly linked list with sentinel nodes
│   ├── sweeper.js           # Active TTL expiry (background sweep)
│   ├── logger.js            # Structured logging (levels, NODE_ID prefix)
│   └── client/
│       ├── index.js         # DistriCacheClient (public API)
│       ├── hash-ring.js     # Consistent hashing with virtual nodes
│       ├── connection-pool.js  # Persistent TCP connection pooling
│       └── health-checker.js   # PING-based failure detection
├── test/
│   ├── lru.test.js          # Linked list unit tests
│   ├── parser.test.js       # Protocol parser tests
│   ├── store.test.js        # Store + LRU ordering tests
│   └── ...
├── benchmark/
│   └── run.js               # Throughput/latency measurement
├── docker-compose.yml       # 3-node cluster
├── Dockerfile
└── package.json             # Zero runtime dependencies
```

---

## Design Decisions

Every choice is deliberate and explainable:

| Decision | Chosen | Why |
|---|---|---|
| **Protocol** | Text over raw TCP | Debuggable via telnet; protocol design is a learning goal |
| **Routing** | Client-side (not proxy) | No single point of failure; mirrors Redis Cluster |
| **Eviction unit** | Entry count (not bytes) | Simpler to reason about; sufficient for portfolio scope |
| **Hash function** | MD5 (for ring) | Available in Node.js stdlib; adequate distribution |
| **Health check** | Client-side PING | Dramatically simpler than consensus; sufficient for demo |
| **Virtual nodes** | 150 per physical node | Good distribution at 3 nodes; verified by test |
| **Replication** | None (v1) | Explicit non-goal; documented as v2 |
| **Persistence** | None (v1) | Explicit non-goal; documented as v2 |
| **Runtime deps** | Zero | "Built from scratch" means no hidden frameworks |

---

## Known Limitations (Documented, Not Hidden)

- **No persistence**: Data lives in memory only. Process dies → data is gone. This is standard for a cache (the upstream DB is the source of truth).
- **No replication**: Keys on a dead node are lost. Acceptable for a cache; a replicated store would need consensus (Raft), which is a v2 scope item.
- **Single-threaded per node**: Node.js's event loop doesn't parallelize CPU work. Fine for I/O-bound cache ops; would need worker threads or multiple processes for CPU-bound workloads.
- **Client-side routing only**: If two clients have different health views, they may briefly route the same key to different nodes (split-brain). Consensus-based membership would solve this.

---

## Build Progress

| Phase | Description | Status |
|---|---|---|
| 1 | Single-node engine (TCP + parser + store) | ✅ Complete |
| 2 | LRU eviction + TTL (lazy + active expiry) | 🔲 Not started |
| 3 | Consistent hashing + client library | 🔲 Not started |
| 4 | Failure detection + Docker Compose | 🔲 Not started |
| 5 | Benchmarks + README polish + CI | 🔲 Not started |

---

## Future Extensions (v2)

- **Persistence**: Periodic snapshots (RDB-style) for restart recovery
- **Replication**: Leader-follower for a subset of keys, demonstrating consistency/availability trade-offs
- **Binary protocol**: Compare parsing performance against text protocol with real benchmarks
- **Pub/Sub**: Channel-based message broadcasting, mirroring another Redis feature

---

## License

[MIT](LICENSE)