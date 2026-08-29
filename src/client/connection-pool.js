import net from 'node:net';

/** @param {string} address @returns {{ host: string, port: number }} */
function parseAddress(address) {
  const lastColon = address.lastIndexOf(':');
  return {
    host: address.slice(0, lastColon),
    port: parseInt(address.slice(lastColon + 1), 10),
  };
}

function createConnection(host, port) {
  const socket = new net.Socket();
  let buffer = '';
  let connected = false;
  let destroyed = false;

  /** @type {Array<{resolve: Function, reject: Function}>} */
  const pending = [];

  function connect() {
    return new Promise((resolve, reject) => {
      if (destroyed) return reject(new Error('Connection has been destroyed'));

      socket.connect(port, host, () => {
        connected = true;
        resolve();
      });

      socket.once('error', (err) => {
        if (!connected) reject(err);
      });
    });
  }

  socket.on('data', (data) => {
    buffer += data.toString();
    drainBuffer();
  });

  socket.on('error', (err) => {
    while (pending.length > 0) pending.shift().reject(err);
  });

  socket.on('close', () => {
    connected = false;
    while (pending.length > 0) pending.shift().reject(new Error('Connection closed'));
  });

  function drainBuffer() {
    while (pending.length > 0 && buffer.length > 0) {
      const type = buffer[0];

      if (type === '+' || type === '-' || type === ':') {
        const end = buffer.indexOf('\r\n');
        if (end === -1) return;

        pending.shift().resolve(buffer.slice(0, end + 2));
        buffer = buffer.slice(end + 2);
      } else if (type === '$') {
        const headerEnd = buffer.indexOf('\r\n');
        if (headerEnd === -1) return;

        const length = parseInt(buffer.slice(1, headerEnd), 10);

        if (length === -1) {
          pending.shift().resolve(buffer.slice(0, headerEnd + 2));
          buffer = buffer.slice(headerEnd + 2);
        } else {
          const totalNeeded = headerEnd + 2 + length + 2;
          if (buffer.length < totalNeeded) return;

          pending.shift().resolve(buffer.slice(0, totalNeeded));
          buffer = buffer.slice(totalNeeded);
        }
      } else {
        pending.shift().reject(new Error(`Unknown response type: ${type}`));
        const end = buffer.indexOf('\r\n');
        buffer = end !== -1 ? buffer.slice(end + 2) : '';
      }
    }
  }

  return {
    connect,

    /** @param {string} rawCommand @returns {Promise<string>} */
    send(rawCommand) {
      return new Promise((resolve, reject) => {
        if (destroyed || !connected) return reject(new Error('Connection not available'));
        pending.push({ resolve, reject });
        socket.write(rawCommand);
      });
    },

    close() {
      destroyed = true;
      connected = false;
      socket.destroy();
    },

    get isConnected() { return connected && !destroyed; },
  };
}

export class ConnectionPool {
  /** @param {{ connectTimeout?: number }} [options] */
  constructor(options = {}) {
    this.connectTimeout = options.connectTimeout ?? 5000;
    /** @type {Map<string, ReturnType<typeof createConnection>>} */
    this.connections = new Map();
  }

  /** @param {string} nodeAddress @returns {Promise<ReturnType<typeof createConnection>>} */
  async _getConnection(nodeAddress) {
    const existing = this.connections.get(nodeAddress);
    if (existing?.isConnected) return existing;

    const { host, port } = parseAddress(nodeAddress);
    const conn = createConnection(host, port);

    await Promise.race([
      conn.connect(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Connection to ${nodeAddress} timed out`)), this.connectTimeout)
      ),
    ]);

    this.connections.set(nodeAddress, conn);
    return conn;
  }

  /**
   * @param {string} nodeAddress
   * @param {string} rawCommand
   * @returns {Promise<string>}
   */
  async send(nodeAddress, rawCommand) {
    const conn = await this._getConnection(nodeAddress);
    return conn.send(rawCommand);
  }

  async close() {
    for (const [, conn] of this.connections) conn.close();
    this.connections.clear();
  }
}
