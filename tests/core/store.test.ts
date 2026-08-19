import { mkdtemp, readFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveAppPaths } from '../../src/core/paths.js';
import { AppStore, createBindCode, hashBindCode, verifyBindCode } from '../../src/core/store.js';

describe('AppStore', () => {
  it('persists secrets with owner-only permissions', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lca-store-'));
    const store = new AppStore(resolveAppPaths(root));
    await store.ensure();
    await store.saveSecrets({ appSecret: 'secret', callbackSecret: 'callback' });
    expect(JSON.parse(await readFile(store.paths.secrets, 'utf8'))).toEqual({
      appSecret: 'secret',
      callbackSecret: 'callback',
    });
    expect((await stat(store.paths.secrets)).mode & 0o777).toBe(0o600);
  });

  it('creates one-way binding code hashes', () => {
    const code = createBindCode();
    const hash = hashBindCode(code);
    expect(code.length).toBeGreaterThanOrEqual(22);
    expect(hash).not.toContain(code);
    expect(verifyBindCode(code, hash)).toBe(true);
    expect(verifyBindCode(`${code}x`, hash)).toBe(false);
  });
});
