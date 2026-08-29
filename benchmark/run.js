import { createCacheServer } from '../src/server.js';
import { DistriCacheClient } from '../src/client/index.js';

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

const formatNumber = (n) => n.toLocaleString('en-US');
const formatNs = (ns) => `${(Number(ns) / 1_000_000).toFixed(2)}ms`;
const percentile = (sorted, p) => sorted[Math.min(Math.floor(sorted.length * p), sorted.length - 1)];

async function runBenchmark(client, ops) {
  const VALUE = 'benchmark-value';

  const setLatencies = new Array(ops);
  const setStart = process.hrtime.bigint();
  for (let i = 0; i < ops; i++) {
    const t = process.hrtime.bigint();
    await client.set(`bench:${i}`, VALUE);
    setLatencies[i] = process.hrtime.bigint() - t;
  }
  const setElapsed = process.hrtime.bigint() - setStart;

  const getLatencies = new Array(ops);
  const getStart = process.hrtime.bigint();
  for (let i = 0; i < ops; i++) {
    const t = process.hrtime.bigint();
    await client.get(`bench:${i}`);
    getLatencies[i] = process.hrtime.bigint() - t;
  }
  const getElapsed = process.hrtime.bigint() - getStart;

  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  setLatencies.sort(cmp);
  getLatencies.sort(cmp);

  const stats = (latencies, elapsed) => ({
    throughput: Math.floor(ops / (Number(elapsed) / 1e9)),
    p50: percentile(latencies, 0.50),
    p95: percentile(latencies, 0.95),
    p99: percentile(latencies, 0.99),
  });

  return { set: stats(setLatencies, setElapsed), get: stats(getLatencies, getElapsed) };
}

function printResults(label, results) {
  console.log(`\n─── ${label} ${'─'.repeat(Math.max(0, 48 - label.length))}\n`);

  for (const op of ['set', 'get']) {
    const r = results[op];
    console.log(`  ${op.toUpperCase()}:`);
    console.log(`    Throughput:  ${formatNumber(r.throughput)} ops/sec`);
    console.log(`    Latency:     p50=${formatNs(r.p50)}  p95=${formatNs(r.p95)}  p99=${formatNs(r.p99)}`);
    console.log('');
  }
}

async function main() {
  const { ops } = parseArgs();

  console.log('DistriCache Benchmark');
  console.log('═════════════════════\n');
  console.log(`Configuration:\n  Operations:  ${formatNumber(ops)}\n  Key space:   ${formatNumber(ops)} unique keys\n  Value size:  ~15 bytes`);

  // Single node
  {
    const server = createCacheServer({ port: 7200, nodeId: 'bench-solo', logLevel: 'error' });
    await server.start();

    const client = new DistriCacheClient(['localhost:7200'], { healthCheck: false });
    for (let i = 0; i < 100; i++) await client.set(`warmup:${i}`, 'x');

    printResults('1 Node (localhost:7200)', await runBenchmark(client, ops));
    await client.close();
    await server.close();
  }

  // Three nodes
  {
    const ports = [7200, 7201, 7202];
    const servers = await Promise.all(
      ports.map(async (port) => {
        const s = createCacheServer({ port, nodeId: `bench-${port}`, logLevel: 'error' });
        await s.start();
        return s;
      })
    );

    const client = new DistriCacheClient(ports.map(p => `localhost:${p}`), { healthCheck: false });
    for (let i = 0; i < 100; i++) await client.set(`warmup:${i}`, 'x');

    printResults('3 Nodes (localhost:7200-7202)', await runBenchmark(client, ops));
    await client.close();
    await Promise.all(servers.map(s => s.close()));
  }

  console.log('═════════════════════');
  console.log('Benchmark complete.\n');
}

main().catch((err) => {
  console.error('Benchmark failed:', err);
  process.exit(1);
});
