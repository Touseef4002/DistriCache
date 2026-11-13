import { ConsistentHashRing } from './hash-ring.js';
import { ConnectionPool } from './connection-pool.js';
import { HealthChecker } from './health-checker.js';

/**
 * @param {string} raw
 * @returns {string|number|null}
 */
function parseResponse(raw) {
  const response = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  const type = String.fromCharCode(response[0]);
  switch (type) {
    case '+': return response.toString('utf8', 1, response.length - 2);
    case '-': throw new Error(response.toString('utf8', 1, response.length - 2));
    case ':': return parseInt(response.toString('ascii', 1, response.length - 2), 10);
    case '$': {
      const headerEnd = response.indexOf('\r\n');
      const length = parseInt(response.toString('ascii', 1, headerEnd), 10);
      if (length === -1) return null;
      return response.toString('utf8', headerEnd + 2, headerEnd + 2 + length);
    }
    default: throw new Error(`Unknown response type: ${type}`);
  }
}

function encodeToken(value) {
  if (/[\r\n]/.test(value)) throw new Error('Command arguments cannot contain line breaks');
  return /[\s"\\]/.test(value)
    ? `"${value.replace(/(["\\])/g, '\\$1')}"`
    : value;
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

    let command = `SET ${encodeToken(key)} ${encodeToken(value)}`;
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
    return parseResponse(await this.pool.send(node, `GET ${encodeToken(key)}\r\n`));
  }

  /**
   * @param {string} key
   * @returns {Promise<number>}
   */
  async del(key) {
    const node = this.ring.getNode(key);
    if (!node) throw new Error('No nodes available');
    return parseResponse(await this.pool.send(node, `DEL ${encodeToken(key)}\r\n`));
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
