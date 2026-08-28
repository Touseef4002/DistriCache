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
| **Tooling** | Benchmark client, Docker Compose orchestration, GitHub Actions CI |

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

### Consistent Hash Ring

Keys are distributed across nodes using a **consistent hash ring** with **150 virtual nodes** per physical node. This ensures:

- **Minimal remapping**: Adding/removing a node only moves ~K/N keys (not all of them)
- **Even distribution**: Verified by tests — 10,000 keys across 3 nodes gives a coefficient of variation of 8.8%

```
         0 / 2³²
           │
  ┌────────┴────────┐
 vA₁               vB₃     ← 150 virtual nodes per physical node
 /                     \       placed at MD5 hash positions
vC₂       RING       vA₂
 \                     /
  vB₁               vC₁    Key lookup: hash(key) → walk clockwise
  └────────┬────────┘       → first virtual node hit = owning node
           │                Binary search: O(log n)
          180°
```

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
ncat localhost 7000
```

### Run a 3-node cluster (Docker)

```bash
docker-compose up -d

# Verify all nodes are running:
# telnet localhost 7000   → PING → +PONG  (node-a)
# telnet localhost 7001   → PING → +PONG  (node-b)
# telnet localhost 7002   → PING → +PONG  (node-c)

# Simulate a node failure:
docker-compose stop node-b

# Tear down:
docker-compose down
```

### Run tests

```bash
npm test
# → 119 tests passing across 8 test suites
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

## Client Library

```javascript
import { DistriCacheClient } from './src/client/index.js';

// Connect to a 3-node cluster
const client = new DistriCacheClient([
  'localhost:7000', 'localhost:7001', 'localhost:7002'
]);

// Basic operations
await client.set('user:42', 'alice');           // → 'OK'
await client.get('user:42');                    // → 'alice'
await client.set('session:abc', 'data', 300);   // TTL: 5 minutes
await client.del('user:42');                    // → 1
await client.ping('localhost:7000');             // → 'PONG'

// Health monitoring
client.getNodeStatus('localhost:7001');          // → 'healthy'
client.getAllNodeStatuses();                     // → Map { 'localhost:7000' → 'healthy', ... }

// Clean up
await client.close();
```

The client automatically:
- **Routes keys** to the correct node via consistent hashing
- **Pools TCP connections** (one per node, lazily created)
- **Detects failures** via periodic PING health checks
- **Removes dead nodes** from the hash ring (keys remap to surviving nodes)
- **Recovers nodes** when they come back online

---

## Failure Detection

The client uses a **3-state health checker** that monitors each node via periodic PINGs:

```
                PING succeeds
                     │
     ┌───────────────▼───────────────┐
     │           HEALTHY             │
     │   (node is on the hash ring)  │
     └───────────────┬───────────────┘
                     │ PING fails
                     ▼
     ┌───────────────────────────────┐
     │           SUSPECT             │
     │   (still on ring, watching)   │──── PING succeeds ──→ HEALTHY
     └───────────────┬───────────────┘
                     │ 3 consecutive failures
                     ▼
     ┌───────────────────────────────┐
     │            DOWN               │
     │   (removed from hash ring)    │──── PING succeeds ──→ HEALTHY
     └───────────────────────────────┘     (re-added to ring)
```

When a node is marked **DOWN**, it's removed from the hash ring. Its keys remap clockwise to the next healthy node — cache misses for those keys, but the cluster stays available. When the node recovers, it's automatically re-added.

---

## Benchmark Results

Measured on local machine with `node benchmark/run.js`:

| Metric | 1 Node | 3 Nodes |
|---|---|---|
| **SET throughput** | 23,803 ops/sec | 25,203 ops/sec |
| **GET throughput** | 26,824 ops/sec | 28,190 ops/sec |
| **SET p50 latency** | 0.03ms | 0.03ms |
| **SET p95 latency** | 0.06ms | 0.05ms |
| **SET p99 latency** | 0.17ms | 0.15ms |
| **GET p50 latency** | 0.03ms | 0.03ms |
| **GET p95 latency** | 0.05ms | 0.04ms |
| **GET p99 latency** | 0.15ms | 0.10ms |

> Configuration: 10,000 sequential operations, ~15-byte values, localhost, Node.js v20

**Key takeaways:**
- **Sub-millisecond latency** at all percentiles (p99 < 0.2ms)
- **Negligible distribution overhead** — 3-node throughput is comparable to 1-node because the hash ring lookup (binary search over 450 entries) is fast relative to TCP I/O
- **GET is faster than SET** as expected — GET doesn't modify the LRU list tail or check capacity

Run it yourself:
```bash
node benchmark/run.js              # Default: 10,000 ops
node benchmark/run.js --ops 50000  # More operations
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
| **Virtual nodes** | 150 per physical node | Good distribution at 3 nodes; verified by test (CV=8.8%) |
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

## Project Structure

```
DistriCache/
├── src/
│   ├── server.js              # TCP server, command dispatch, response formatting
│   ├── parser.js              # Wire protocol parser (stream buffering, quoted strings)
│   ├── store.js               # HashMap + LRU list (the O(1) cache)
│   ├── lru.js                 # Doubly linked list with sentinel nodes
│   ├── sweeper.js             # Active TTL expiry (background random sampling)
│   ├── logger.js              # Structured logging (levels, NODE_ID prefix)
│   └── client/
│       ├── index.js           # DistriCacheClient (public API)
│       ├── hash-ring.js       # Consistent hashing with virtual nodes
│       ├── connection-pool.js # Persistent TCP connection pooling
│       └── health-checker.js  # PING-based failure detection state machine
├── test/                      # 119 tests across 8 suites
│   ├── lru.test.js            # Linked list unit tests
│   ├── parser.test.js         # Protocol parser tests
│   ├── store.test.js          # Store + LRU + TTL tests
│   ├── sweeper.test.js        # Active expiry sweeper tests
│   ├── hash-ring.test.js      # Hash ring determinism + remapping tests
│   ├── distribution.test.js   # Key distribution evenness (statistical)
│   ├── integration.test.js    # 3-node cluster end-to-end tests
│   └── health-checker.test.js # Failure detection state machine tests
├── benchmark/
│   └── run.js                 # Throughput + latency measurement tool
├── .github/workflows/
│   └── ci.yml                 # GitHub Actions: test on push/PR
├── Dockerfile                 # node:20-alpine, production image
├── docker-compose.yml         # 3-node cluster orchestration
├── .dockerignore
└── package.json               # Zero runtime dependencies
```

---

## Future Extensions (v2)

- **Persistence**: Periodic snapshots (RDB-style) for restart recovery
- **Replication**: Leader-follower for a subset of keys, demonstrating consistency/availability trade-offs
- **Binary protocol**: Compare parsing performance against text protocol with real benchmarks
- **Pub/Sub**: Channel-based message broadcasting, mirroring another Redis feature
- **Pipelining**: Send multiple commands without waiting for each response, measuring concurrent throughput

---

## License

[MIT](LICENSE)