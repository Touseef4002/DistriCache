import { ConsistentHashRing } from './hash-ring.js';
import { ConnectionPool } from './connection-pool.js';
import { HealthChecker } from './health-checker.js';

/**
 * @param {string} raw
 * @returns {string|number|null}
 */
function parseResponse(raw) {
  switch (raw[0]) {
    case '+': return raw.slice(1, -2);
    case '-': throw new Error(raw.slice(1, -2));
    case ':': return parseInt(raw.slice(1, -2), 10);
    case '$': {
      const headerEnd = raw.indexOf('\r\n');
      const length = parseInt(raw.slice(1, headerEnd), 10);
      if (length === -1) return null;
      return raw.slice(headerEnd + 2, headerEnd + 2 + length);
    }
    default: throw new Error(`Unknown response type: ${raw[0]}`);
  }
}

export class DistriCacheClient {
  /**
   * @param {string[]} nodes
   * @param {{ virtualNodes?: number, connectTimeout?: number, healthCheck?: boolean, pingInterval?: number, pingTimeout?: number, failureThreshold?: number, onStateChange?: Function }} [options]
   */
  constructor(nodes, options = {}) {
    if (!nodes || nodes.length === 0) {
      throw new Error('At least one node address is required');
    }

    this.ring = new ConsistentHashRing(nodes, options.virtualNodes);
    this.pool = new ConnectionPool({ connectTimeout: options.connectTimeout });
    this.nodes = [...nodes];
    this.healthChecker = null;

    if (options.healthCheck !== false) {
      this.healthChecker = new HealthChecker(nodes, this.ring, {
        pingInterval: options.pingInterval,
        pingTimeout: options.pingTimeout,
        failureThreshold: options.failureThreshold,
        onStateChange: options.onStateChange,
      });
      this.healthChecker.start();
    }
  }

  /**
   * @param {string} key
   * @param {string} value
   * @param {number} [ttlSeconds]
   * @returns {Promise<string>}
   */
  async set(key, value, ttlSeconds) {
    const node = this.ring.getNode(key);
    if (!node) throw new Error('No nodes available');

    const quotedValue = value.includes(' ') ? `"${value}"` : value;
    let command = `SET ${key} ${quotedValue}`;
    if (ttlSeconds != null) command += ` EX ${ttlSeconds}`;
    command += '\r\n';

    return parseResponse(await this.pool.send(node, command));
  }

  /**
   * @param {string} key
   * @returns {Promise<string|null>}
   */
  async get(key) {
    const node = this.ring.getNode(key);
    if (!node) throw new Error('No nodes available');
    return parseResponse(await this.pool.send(node, `GET ${key}\r\n`));
  }

  /**
   * @param {string} key
   * @returns {Promise<number>}
   */
  async del(key) {
    const node = this.ring.getNode(key);
    if (!node) throw new Error('No nodes available');
    return parseResponse(await this.pool.send(node, `DEL ${key}\r\n`));
  }

  /**
   * @param {string} [nodeAddress]
   * @returns {Promise<string>}
   */
  async ping(nodeAddress) {
    return parseResponse(await this.pool.send(nodeAddress || this.nodes[0], 'PING\r\n'));
  }

  /** @param {string} nodeAddress @returns {string} */
  getNodeStatus(nodeAddress) {
    return this.healthChecker?.getNodeStatus(nodeAddress) ?? 'healthy';
  }

  /** @returns {Map<string, string>} */
  getAllNodeStatuses() {
    if (this.healthChecker) return this.healthChecker.getAllNodeStatuses();
    return new Map(this.nodes.map(n => [n, 'healthy']));
  }

  async close() {
    this.healthChecker?.stop();
    await this.pool.close();
  }
}

export { parseResponse };
