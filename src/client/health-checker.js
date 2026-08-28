/**
 * health-checker.js — Client-side failure detection for DistriCache.
 *
 * WHAT THIS MODULE DOES
 * ═════════════════════
 * In a distributed cache, nodes can crash, hang, or become unreachable.
 * The client needs to detect this and stop routing keys to dead nodes —
 * otherwise, every request to a dead node hangs or errors.
 *
 * This module implements a client-side health checker that periodically
 * PINGs each node and manages a state machine per node:
 *
 *   Healthy → (PING timeout) → Suspect
 *   Suspect → (PING success) → Healthy
 *   Suspect → (N consecutive failures) → Down
 *   Down    → (PING success) → Healthy
 *   Down    → (PING timeout) → Down (stays)
 *
 * When a node transitions to Down, it's removed from the hash ring
 * so keys that were mapped to it reroute to the next clockwise node.
 * When a node recovers, it's re-added to the ring.
 *
 * WHY CLIENT-SIDE, NOT SERVER-SIDE?
 * ─────────────────────────────────
 * Alternative: nodes gossip with each other about who's alive (like
 * Cassandra's gossip protocol) or elect a leader to manage membership
 * (like Raft in etcd/Consul).
 *
 * Client-side health checking is much simpler:
 *   ✅ No inter-node communication needed (nodes stay topology-unaware)
 *   ✅ No consensus protocol to implement
 *   ✅ Each client independently detects failures from its own perspective
 *   ❌ Split-brain risk: two clients may disagree about which nodes are up
 *
 * The split-brain risk is a known and documented limitation (ARCHITECTURE.md §8.4).
 * For a cache (not a database), this is acceptable — the worst case is a
 * temporary cache miss, not data loss or inconsistency.
 *
 * WHY FRESH TCP CONNECTIONS FOR PINGS?
 * ─────────────────────────────────────
 * We open a new TCP connection for each health check instead of reusing
 * the connection pool. This verifies the full TCP path:
 *   1. DNS resolution (if applicable)
 *   2. TCP 3-way handshake (SYN → SYN-ACK → ACK)
 *   3. Command processing (PING → PONG)
 *
 * A pooled connection could appear "alive" (no FIN received) even if the
 * remote process has crashed but the OS hasn't cleaned up yet. A fresh
 * connection catches this case because the handshake will fail.
 *
 * WHY A STATE MACHINE INSTEAD OF JUST "UP/DOWN"?
 * ────────────────────────────────────────────────
 * A single PING failure could be a transient network blip, not a real crash.
 * The Suspect state acts as a buffer — we only mark a node Down after
 * `failureThreshold` consecutive failures. This prevents flapping:
 * rapidly adding/removing a node from the ring, which would cause
 * unnecessary key remapping and cache misses.
 *
 * This is the same approach used by:
 *   - Consul (uses a configurable failure threshold)
 *   - Kubernetes liveness probes (configurable failureThreshold)
 *   - AWS ELB health checks (configurable unhealthy threshold)
 */

import net from 'node:net';

/**
 * Node health states.
 * Exported for use in tests and by the client.
 */
export const NodeState = Object.freeze({
  HEALTHY: 'healthy',
  SUSPECT: 'suspect',
  DOWN: 'down',
});

/**
 * Parse a "host:port" address string into its components.
 * @param {string} address
 * @returns {{ host: string, port: number }}
 */
function parseAddress(address) {
  const lastColon = address.lastIndexOf(':');
  return {
    host: address.slice(0, lastColon),
    port: parseInt(address.slice(lastColon + 1), 10),
  };
}

/**
 * Send a PING to a node and wait for PONG.
 *
 * Opens a fresh TCP connection, sends PING\r\n, waits for +PONG\r\n,
 * and closes the connection. The entire operation is bounded by `timeoutMs`.
 *
 * @param {string} host - The hostname to connect to
 * @param {number} port - The port to connect to
 * @param {number} timeoutMs - Max time for the entire PING operation
 * @returns {Promise<boolean>} true if PONG received, false on any failure
 */
function pingNode(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    // Timeout covers the entire operation: connect + send + receive.
    // If anything takes longer than timeoutMs, we treat it as a failure.
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(false);
      }
    }, timeoutMs);

    socket.connect(port, host, () => {
      // Connected — send PING
      socket.write('PING\r\n');
    });

    socket.on('data', (data) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        // Check if we received +PONG\r\n
        const response = data.toString();
        resolve(response.startsWith('+PONG'));
      }
    });

    socket.on('error', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(false);
      }
    });

    socket.on('close', () => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve(false);
      }
    });
  });
}

export class HealthChecker {
  /**
   * Create a health checker for a set of cache nodes.
   *
   * @param {string[]} nodes - Node addresses to monitor, e.g., ['localhost:7000']
   * @param {import('./hash-ring.js').ConsistentHashRing} ring - Hash ring to update on state transitions
   * @param {object} [options]
   * @param {number} [options.pingInterval=2000] - How often to PING each node (ms)
   * @param {number} [options.pingTimeout=1000] - Max wait for PONG (ms)
   * @param {number} [options.failureThreshold=3] - Consecutive failures before marking Down
   * @param {Function} [options.onStateChange] - Callback: (nodeId, oldState, newState) => void
   */
  constructor(nodes, ring, options = {}) {
    this.ring = ring;
    this.pingInterval = options.pingInterval ?? 2000;
    this.pingTimeout = options.pingTimeout ?? 1000;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.onStateChange = options.onStateChange || null;

    /**
     * Per-node health state.
     * Each entry tracks the current state and the count of consecutive
     * PING failures (used for the Suspect → Down transition).
     *
     * @type {Map<string, { state: string, consecutiveFailures: number }>}
     */
    this.nodeStates = new Map();

    for (const node of nodes) {
      this.nodeStates.set(node, {
        state: NodeState.HEALTHY,
        consecutiveFailures: 0,
      });
    }

    /** @type {NodeJS.Timeout|null} Interval timer handle */
    this._timer = null;
  }

  /**
   * Start the periodic health check loop.
   *
   * Each tick PINGs ALL nodes concurrently (not sequentially) to minimize
   * the time between health checks. If we PINGed serially and one node
   * was slow to respond, it would delay the checks for all other nodes.
   */
  start() {
    if (this._timer) return; // Already running

    // Run an initial check immediately, then on interval
    this._checkAll();

    this._timer = setInterval(() => {
      this._checkAll();
    }, this.pingInterval);

    // Unref so the timer doesn't prevent Node.js from exiting
    // (same pattern as sweeper.js)
    this._timer.unref();
  }

  /**
   * Stop the health checker. Must be called during client shutdown.
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Get the current health state of a specific node.
   *
   * @param {string} nodeAddress
   * @returns {string} 'healthy', 'suspect', or 'down'
   */
  getNodeStatus(nodeAddress) {
    const entry = this.nodeStates.get(nodeAddress);
    return entry ? entry.state : NodeState.DOWN;
  }

  /**
   * Get a snapshot of all node health states.
   *
   * @returns {Map<string, string>} nodeAddress → state
   */
  getAllNodeStatuses() {
    const result = new Map();
    for (const [node, entry] of this.nodeStates) {
      result.set(node, entry.state);
    }
    return result;
  }

  /**
   * PING all nodes concurrently and update their states.
   * @private
   */
  _checkAll() {
    for (const [node] of this.nodeStates) {
      this._checkNode(node);
    }
  }

  /**
   * PING a single node and update its state machine.
   *
   * STATE MACHINE TRANSITIONS:
   *
   *   On PING success:
   *     Any state → Healthy (reset failures to 0)
   *     If was Down → re-add to hash ring
   *
   *   On PING failure:
   *     consecutiveFailures++
   *     If consecutiveFailures < threshold → Suspect
   *     If consecutiveFailures >= threshold → Down
   *     If transitioning to Down → remove from hash ring
   *
   * @param {string} nodeAddress
   * @private
   */
  async _checkNode(nodeAddress) {
    const { host, port } = parseAddress(nodeAddress);
    const success = await pingNode(host, port, this.pingTimeout);
    const entry = this.nodeStates.get(nodeAddress);
    if (!entry) return; // Node was removed from tracking

    const oldState = entry.state;

    if (success) {
      // ─── PING succeeded ──────────────────────────────────────────
      entry.consecutiveFailures = 0;

      if (oldState !== NodeState.HEALTHY) {
        entry.state = NodeState.HEALTHY;

        if (oldState === NodeState.DOWN) {
          // Node recovered — re-add to the hash ring so keys can
          // route back to it. This causes a small remapping of keys
          // (only those in the arc that this node now owns again).
          this.ring.addNode(nodeAddress);
        }

        if (this.onStateChange) {
          this.onStateChange(nodeAddress, oldState, NodeState.HEALTHY);
        }
      }
    } else {
      // ─── PING failed ─────────────────────────────────────────────
      entry.consecutiveFailures++;

      if (entry.consecutiveFailures >= this.failureThreshold) {
        // Enough consecutive failures → mark as Down
        if (oldState !== NodeState.DOWN) {
          entry.state = NodeState.DOWN;

          // Remove from hash ring — keys that were mapped to this node
          // will now route to the next clockwise node on the ring.
          // Those keys will result in cache misses (data was on the dead
          // node and is lost — no replication in v1).
          this.ring.removeNode(nodeAddress);

          if (this.onStateChange) {
            this.onStateChange(nodeAddress, oldState, NodeState.DOWN);
          }
        }
      } else {
        // Below threshold → Suspect (but not Down yet)
        if (oldState !== NodeState.SUSPECT) {
          entry.state = NodeState.SUSPECT;

          if (this.onStateChange) {
            this.onStateChange(nodeAddress, oldState, NodeState.SUSPECT);
          }
        }
      }
    }
  }
}
