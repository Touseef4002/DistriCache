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
  let buffer = Buffer.alloc(0);
  let connected = false;
  let destroyed = false;

  /** @type {Array<{resolve: Function, reject: Function}>} */
  const pending = [];

  function connect() {
    return new Promise((resolve, reject) => {
      if (destroyed) return reject(new Error('Connection has been destroyed'));

      const cleanup = () => {
        socket.off('connect', onConnect);
        socket.off('error', onError);
        socket.off('close', onClose);
      };
      const onConnect = () => {
        connected = true;
        cleanup();
        resolve();
      };
      const onError = (err) => {
        cleanup();
        reject(err);
      };
      const onClose = () => {
        cleanup();
        reject(new Error('Connection closed before connect'));
      };

      socket.once('connect', onConnect);
      socket.once('error', onError);
      socket.once('close', onClose);
      socket.connect(port, host);
    });
  }

  socket.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
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
      const type = String.fromCharCode(buffer[0]);

      if (type === '+' || type === '-' || type === ':') {
        const end = buffer.indexOf('\r\n');
        if (end === -1) return;

        pending.shift().resolve(buffer.subarray(0, end + 2).toString('utf8'));
        buffer = buffer.subarray(end + 2);
      } else if (type === '$') {
        const headerEnd = buffer.indexOf('\r\n');
        if (headerEnd === -1) return;

        const length = parseInt(buffer.toString('ascii', 1, headerEnd), 10);

        if (length === -1) {
          pending.shift().resolve(buffer.subarray(0, headerEnd + 2).toString('utf8'));
          buffer = buffer.subarray(headerEnd + 2);
        } else {
          const totalNeeded = headerEnd + 2 + length + 2;
          if (buffer.length < totalNeeded) return;

          pending.shift().resolve(buffer.subarray(0, totalNeeded).toString('utf8'));
          buffer = buffer.subarray(totalNeeded);
        }
      } else {
        pending.shift().reject(new Error(`Unknown response type: ${type}`));
        const end = buffer.indexOf('\r\n');
        buffer = end !== -1 ? buffer.subarray(end + 2) : Buffer.alloc(0);
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
    this.pendingConnections = new Map();
  }

  /** @param {string} nodeAddress @returns {Promise<ReturnType<typeof createConnection>>} */
  async _getConnection(nodeAddress) {
    const existing = this.connections.get(nodeAddress);
    if (existing?.isConnected) return existing;
    const pending = this.pendingConnections.get(nodeAddress);
    if (pending) return pending.promise;

    const { host, port } = parseAddress(nodeAddress);
    const conn = createConnection(host, port);
    const pendingConnection = { conn, promise: null };
    let timer;
    const connecting = (async () => {
      try {
        await Promise.race([
          conn.connect(),
          new Promise((_, reject) => {
            timer = setTimeout(() => {
              conn.close();
              reject(new Error(`Connection to ${nodeAddress} timed out`));
            }, this.connectTimeout);
          }),
        ]);
        this.connections.set(nodeAddress, conn);
        return conn;
      } catch (err) {
        conn.close();
        throw err;
      } finally {
        clearTimeout(timer);
        if (this.pendingConnections.get(nodeAddress) === pendingConnection) {
          this.pendingConnections.delete(nodeAddress);
        }
      }
    })();
    pendingConnection.promise = connecting;
    this.pendingConnections.set(nodeAddress, pendingConnection);
    return connecting;
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
    for (const { conn } of this.pendingConnections.values()) conn.close();
    this.connections.clear();
    this.pendingConnections.clear();
  }
}
