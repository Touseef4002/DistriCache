/**
 * benchmark/run.js — Performance benchmark for DistriCache.
 *
 * WHAT THIS MEASURES
 * ══════════════════
 * This benchmark measures the real throughput and latency of DistriCache
 * operations (SET and GET) under two configurations:
 *
 *   1. SINGLE NODE:  1 server, measuring raw per-node performance
 *   2. THREE NODES:  3 servers with consistent hashing, measuring the
 *                    overhead (if any) of distributed routing
 *
 * METHODOLOGY
 * ───────────
 * For each configuration:
 *   1. Start server(s) programmatically
 *   2. Create a DistriCacheClient pointed at them
 *   3. Run N sequential SET operations, recording each latency
 *   4. Run N sequential GET operations on the same keys
 *   5. Calculate throughput (ops/sec) and latency percentiles (p50/p95/p99)
 *   6. Tear everything down
 *
 * LATENCY MEASUREMENT
 * ───────────────────
 * We use `process.hrtime.bigint()` which gives nanosecond-precision
 * monotonic timestamps. This is far more precise than `Date.now()` (which
 * has millisecond resolution) and isn't affected by system clock adjustments.
 *
 * Latencies are stored in a sorted array and percentiles are read by index:
 *   p50 = latencies[Math.floor(N * 0.50)]
 *   p95 = latencies[Math.floor(N * 0.95)]
 *   p99 = latencies[Math.floor(N * 0.99)]
 *
 * This is O(N log N) for the sort, but N=10,000 is tiny. No need for
 * streaming percentile algorithms (t-digest, HDR histogram) at this scale.
 *
 * WHY SEQUENTIAL (NOT CONCURRENT)?
 * ────────────────────────────────
 * Our v1 connection pool uses one connection per node, and each connection
 * serializes requests (no pipelining). Sending concurrent requests would
 * just queue them on the same socket. Sequential measurement gives the
 * clearest picture of single-request latency.
 *
 * For a v2 benchmark, we could add pipelining or multiple connections per
 * node to measure concurrent throughput.
 *
 * USAGE
 * ─────
 *   node benchmark/run.js                  # Default: 10,000 ops
 *   node benchmark/run.js --ops 50000      # Custom operation count
 */

import { createCacheServer } from '../src/server.js';
import { DistriCacheClient } from '../src/client/index.js';

// ─── Configuration ──────────────────────────────────────────────────

const DEFAULT_OPS = 10000;

function parseArgs() {
  const args = process.argv.slice(2);
  let ops = DEFAULT_OPS;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--ops' && args[i + 1]) {
      ops = parseInt(args[i + 1], 10);
      i++;
    }
  }

  return { ops };
}

// ─── Formatting helpers ─────────────────────────────────────────────

/**
 * Format a number with commas for readability: 12345 → "12,345"
 */
function formatNumber(n) {
  return n.toLocaleString('en-US');
}

/**
 * Format nanoseconds as milliseconds with 2 decimal places: 75000n → "0.08ms"
 */
function formatNs(ns) {
  return (Number(ns) / 1_000_000).toFixed(2) + 'ms';
}

/**
 * Calculate percentile from a sorted array.
 * @param {BigInt64Array|BigInt[]} sorted - Sorted latencies in nanoseconds
 * @param {number} p - Percentile (0-1), e.g., 0.50 for p50
 * @returns {BigInt}
 */
function percentile(sorted, p) {
  const index = Math.min(Math.floor(sorted.length * p), sorted.length - 1);
  return sorted[index];
}

// ─── Benchmark runner ───────────────────────────────────────────────

/**
 * Run SET and GET benchmarks against a client.
 *
 * @param {DistriCacheClient} client
 * @param {number} ops - Number of operations to run
 * @returns {Promise<{set: object, get: object}>} Results for SET and GET
 */
async function runBenchmark(client, ops) {
  const VALUE = 'benchmark-value';  // ~15 bytes, typical cache value size

  // ─── SET benchmark ──────────────────────────────────────────────
  const setLatencies = new Array(ops);
  const setStart = process.hrtime.bigint();

  for (let i = 0; i < ops; i++) {
    const opStart = process.hrtime.bigint();
    await client.set(`bench:${i}`, VALUE);
    setLatencies[i] = process.hrtime.bigint() - opStart;
  }

  const setElapsed = process.hrtime.bigint() - setStart;

  // ─── GET benchmark ──────────────────────────────────────────────
  const getLatencies = new Array(ops);
  const getStart = process.hrtime.bigint();

  for (let i = 0; i < ops; i++) {
    const opStart = process.hrtime.bigint();
    await client.get(`bench:${i}`);
    getLatencies[i] = process.hrtime.bigint() - opStart;
  }

  const getElapsed = process.hrtime.bigint() - getStart;

  // ─── Calculate stats ───────────────────────────────────────────
  setLatencies.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  getLatencies.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));

  return {
    set: {
      throughput: Math.floor(ops / (Number(setElapsed) / 1_000_000_000)),
      p50: percentile(setLatencies, 0.50),
      p95: percentile(setLatencies, 0.95),
      p99: percentile(setLatencies, 0.99),
    },
    get: {
      throughput: Math.floor(ops / (Number(getElapsed) / 1_000_000_000)),
      p50: percentile(getLatencies, 0.50),
      p95: percentile(getLatencies, 0.95),
      p99: percentile(getLatencies, 0.99),
    },
  };
}

/**
 * Print results for one benchmark scenario.
 */
function printResults(label, results) {
  console.log(`\n─── ${label} ${'─'.repeat(Math.max(0, 48 - label.length))}\n`);

  console.log('  SET:');
  console.log(`    Throughput:  ${formatNumber(results.set.throughput)} ops/sec`);
  console.log(`    Latency:     p50=${formatNs(results.set.p50)}  p95=${formatNs(results.set.p95)}  p99=${formatNs(results.set.p99)}`);

  console.log('');
  console.log('  GET:');
  console.log(`    Throughput:  ${formatNumber(results.get.throughput)} ops/sec`);
  console.log(`    Latency:     p50=${formatNs(results.get.p50)}  p95=${formatNs(results.get.p95)}  p99=${formatNs(results.get.p99)}`);
}

// ─── Main ───────────────────────────────────────────────────────────

async function main() {
  const { ops } = parseArgs();

  console.log('DistriCache Benchmark');
  console.log('═════════════════════\n');
  console.log('Configuration:');
  console.log(`  Operations:  ${formatNumber(ops)}`);
  console.log(`  Key space:   ${formatNumber(ops)} unique keys`);
  console.log(`  Value size:  ~15 bytes`);

  // ─── Benchmark 1: Single node ──────────────────────────────────
  // Use port 7200+ to avoid conflicts with any running dev servers
  {
    const server = createCacheServer({
      port: 7200,
      nodeId: 'bench-solo',
      logLevel: 'error',
    });
    await server.start();

    const client = new DistriCacheClient(['localhost:7200'], {
      healthCheck: false,  // No health checking during benchmark
    });

    // Warm up: let the connection establish and JIT optimize
    for (let i = 0; i < 100; i++) {
      await client.set(`warmup:${i}`, 'x');
    }

    const results = await runBenchmark(client, ops);
    printResults(`1 Node (localhost:7200)`, results);

    await client.close();
    await server.close();
  }

  // ─── Benchmark 2: Three nodes ──────────────────────────────────
  {
    const ports = [7200, 7201, 7202];
    const servers = [];

    for (const port of ports) {
      const server = createCacheServer({
        port,
        nodeId: `bench-${port}`,
        logLevel: 'error',
      });
      await server.start();
      servers.push(server);
    }

    const nodes = ports.map(p => `localhost:${p}`);
    const client = new DistriCacheClient(nodes, {
      healthCheck: false,
    });

    // Warm up
    for (let i = 0; i < 100; i++) {
      await client.set(`warmup:${i}`, 'x');
    }

    const results = await runBenchmark(client, ops);
    printResults(`3 Nodes (localhost:7200-7202)`, results);

    await client.close();
    for (const server of servers) {
      await server.close();
    }
  }

  console.log('\n═════════════════════');
  console.log('Benchmark complete.\n');
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
