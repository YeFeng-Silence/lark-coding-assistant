import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import type { DaemonRequestInput, DaemonResult } from './protocol.js';

export function requestDaemon(
  socketPath: string,
  request: DaemonRequestInput,
  timeoutMs = 5000,
): Promise<DaemonResult> {
  return new Promise((resolve, reject) => {
    const id = randomUUID();
    const socket = createConnection(socketPath);
    let buffer = '';
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error('daemon request timed out'));
    }, timeoutMs);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(`${JSON.stringify({ ...request, id })}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) return;
      clearTimeout(timer);
      socket.destroy();
      try {
        resolve(JSON.parse(buffer.slice(0, newline)) as DaemonResult);
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}
