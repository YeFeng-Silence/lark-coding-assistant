import { mkdir, mkdtemp } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { requestDaemon } from '../../src/daemon/client.js';

describe('daemon client errors', () => {
  it('classifies unavailable sockets', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lca-client-missing-'));
    const request = requestDaemon(join(root, 'missing.sock'), { method: 'ping' }, 100);
    await expect(request).rejects.toMatchObject({ code: 'DAEMON_UNAVAILABLE' });
  });

  it('classifies response timeouts', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lca-client-timeout-'));
    await mkdir(root, { recursive: true });
    const socketPath = join(root, 'daemon.sock');
    const server = createServer((socket) => socket.once('data', () => undefined));
    await new Promise<void>((resolveListen, reject) => {
      server.once('error', reject);
      server.listen(socketPath, resolveListen);
    });
    try {
      await expect(requestDaemon(socketPath, { method: 'ping' }, 25))
        .rejects.toMatchObject({ code: 'REQUEST_TIMEOUT' });
    } finally {
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    }
  });
});
