import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../src/core/paths.js';
import { daemonInfo, startDaemonProcess, stopDaemonProcess } from '../../src/daemon/lifecycle.js';

describe('daemon lifecycle diagnostics', () => {
  it('captures detached daemon stderr when startup crashes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lca-daemon-crash-'));
    const paths = resolveAppPaths(root);
    const entry = join(root, 'crash.mjs');
    await writeFile(entry, 'console.error("INTENTIONAL_DAEMON_CRASH"); process.exit(7);\n');

    await expect(startDaemonProcess(paths, entry, 400)).rejects.toThrow('daemon did not become ready');
    await expect.poll(async () => readFile(paths.logFile, 'utf8')).toContain('INTENTIONAL_DAEMON_CRASH');
  });

  it('rejects ping responses that do not use the current daemon-info protocol', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lca-daemon-protocol-'));
    const paths = resolveAppPaths(root);
    await mkdir(paths.runtimeDir, { recursive: true });
    await writeFile(paths.pid, String(process.pid));
    const server = createServer((socket) => {
      socket.once('data', () => socket.end(`${JSON.stringify({ ok: true })}\n`));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(paths.socket, resolve);
    });
    try {
      await expect(daemonInfo(paths)).resolves.toBeUndefined();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('refuses to signal a live PID that is not the current daemon executable', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lca-daemon-pid-'));
    const paths = resolveAppPaths(root);
    await mkdir(paths.runtimeDir, { recursive: true });
    await writeFile(paths.pid, String(process.pid));

    await expect(stopDaemonProcess(paths)).rejects.toThrow('is not a lark-coding-assistant daemon');
  });
});
