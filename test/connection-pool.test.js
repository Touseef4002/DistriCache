import net from 'node:net';
import { describe, test, expect } from '@jest/globals';
import { ConnectionPool } from '../src/client/connection-pool.js';
import { parseResponse } from '../src/client/index.js';

function listen(server) {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function close(server) {
  return new Promise(resolve => server.close(resolve));
}

describe('ConnectionPool', () => {
  test('shares one in-flight connection between concurrent requests', async () => {
    let connections = 0;
    const server = net.createServer(socket => {
      connections++;
      let buffer = '';
      socket.on('data', chunk => {
        buffer += chunk.toString();
        while (buffer.includes('\r\n')) {
          buffer = buffer.slice(buffer.indexOf('\r\n') + 2);
          socket.write('+PONG\r\n');
        }
      });
    });
    const port = await listen(server);
    const pool = new ConnectionPool();

    try {
      const results = await Promise.all(
        Array.from({ length: 10 }, () => pool.send(`127.0.0.1:${port}`, 'PING\r\n')),
      );
      expect(results).toEqual(Array(10).fill('+PONG\r\n'));
      expect(connections).toBe(1);
    } finally {
      await pool.close();
      await close(server);
    }
  });

  test('removes a refused connection attempt from the pool', async () => {
    const reservation = net.createServer();
    const port = await listen(reservation);
    await close(reservation);

    const pool = new ConnectionPool({ connectTimeout: 1000 });
    await expect(pool.send(`127.0.0.1:${port}`, 'PING\r\n')).rejects.toThrow();
    expect(pool.connections.size).toBe(0);
    expect(pool.pendingConnections.size).toBe(0);
    await pool.close();
  });

  test('frames a UTF-8 bulk response split inside a character', async () => {
    const server = net.createServer(socket => {
      socket.once('data', () => {
        const value = Buffer.from('你好 🌍');
        const header = Buffer.from(`$${value.length}\r\n`);
        const response = Buffer.concat([header, value, Buffer.from('\r\n')]);
        const split = header.length + 1;
        socket.write(response.subarray(0, split));
        setTimeout(() => socket.write(response.subarray(split)), 10);
      });
    });
    const port = await listen(server);
    const pool = new ConnectionPool();

    try {
      const raw = await pool.send(`127.0.0.1:${port}`, 'GET key\r\n');
      expect(parseResponse(raw)).toBe('你好 🌍');
    } finally {
      await pool.close();
      await close(server);
    }
  });

  test('close() cancels an in-flight connection attempt', async () => {
    const server = net.createServer();
    const port = await listen(server);
    const pool = new ConnectionPool({ connectTimeout: 1000 });
    const connecting = pool._getConnection(`127.0.0.1:${port}`);

    await pool.close();
    await expect(connecting).rejects.toThrow();
    await close(server);
  });
});
