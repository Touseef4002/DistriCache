import net from 'node:net';

export const NodeState = Object.freeze({
  HEALTHY: 'healthy',
  SUSPECT: 'suspect',
  DOWN: 'down',
});

/** @param {string} address @returns {{ host: string, port: number }} */
function parseAddress(address) {
  const lastColon = address.lastIndexOf(':');
  return {
    host: address.slice(0, lastColon),
    port: parseInt(address.slice(lastColon + 1), 10),
  };
}

/**
 * Send a PING to a node via a fresh TCP connection.
 * @param {string} host
 * @param {number} port
 * @param {number} timeoutMs
 * @returns {Promise<boolean>}
 */
function pingNode(host, port, timeoutMs) {
  return new Promise((resolve) => {
    const socket = new net.Socket();
    let settled = false;

    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const timer = setTimeout(() => settle(false), timeoutMs);

    socket.connect(port, host, () => socket.write('PING\r\n'));
    socket.on('data', (data) => settle(data.toString().startsWith('+PONG')));
    socket.on('error', () => settle(false));
    socket.on('close', () => settle(false));
  });
}

export class HealthChecker {
  /**
   * @param {string[]} nodes
   * @param {import('./hash-ring.js').ConsistentHashRing} ring
   * @param {{ pingInterval?: number, pingTimeout?: number, failureThreshold?: number, onStateChange?: Function }} [options]
   */
  constructor(nodes, ring, options = {}) {
    this.ring = ring;
    this.pingInterval = options.pingInterval ?? 2000;
    this.pingTimeout = options.pingTimeout ?? 1000;
    this.failureThreshold = options.failureThreshold ?? 3;
    this.onStateChange = options.onStateChange || null;

    /** @type {Map<string, { state: string, consecutiveFailures: number }>} */
    this.nodeStates = new Map();
    for (const node of nodes) {
      this.nodeStates.set(node, { state: NodeState.HEALTHY, consecutiveFailures: 0 });
    }

    /** @type {NodeJS.Timeout|null} */
    this._timer = null;
  }

  start() {
    if (this._timer) return;
    this._checkAll();
    this._timer = setInterval(() => this._checkAll(), this.pingInterval);
    this._timer.unref();
  }

  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /** @param {string} nodeAddress @returns {string} */
  getNodeStatus(nodeAddress) {
    return this.nodeStates.get(nodeAddress)?.state ?? NodeState.DOWN;
  }

  /** @returns {Map<string, string>} */
  getAllNodeStatuses() {
    const result = new Map();
    for (const [node, entry] of this.nodeStates) {
      result.set(node, entry.state);
    }
    return result;
  }

  /** @private */
  _checkAll() {
    for (const [node] of this.nodeStates) this._checkNode(node);
  }

  /**
   * @param {string} nodeAddress
   * @private
   */
  async _checkNode(nodeAddress) {
    const { host, port } = parseAddress(nodeAddress);
    const success = await pingNode(host, port, this.pingTimeout);
    const entry = this.nodeStates.get(nodeAddress);
    if (!entry) return;

    const oldState = entry.state;

    if (success) {
      entry.consecutiveFailures = 0;

      if (oldState !== NodeState.HEALTHY) {
        entry.state = NodeState.HEALTHY;
        if (oldState === NodeState.DOWN) this.ring.addNode(nodeAddress);
        this.onStateChange?.(nodeAddress, oldState, NodeState.HEALTHY);
      }
    } else {
      entry.consecutiveFailures++;

      if (entry.consecutiveFailures >= this.failureThreshold) {
        if (oldState !== NodeState.DOWN) {
          entry.state = NodeState.DOWN;
          this.ring.removeNode(nodeAddress);
          this.onStateChange?.(nodeAddress, oldState, NodeState.DOWN);
        }
      } else if (oldState !== NodeState.SUSPECT) {
        entry.state = NodeState.SUSPECT;
        this.onStateChange?.(nodeAddress, oldState, NodeState.SUSPECT);
      }
    }
  }
}
