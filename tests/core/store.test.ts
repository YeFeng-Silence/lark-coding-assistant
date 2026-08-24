import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
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

  it('migrates legacy agent ids in config and state on load', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lca-store-migrate-'));
    const store = new AppStore(resolveAppPaths(root));
    await store.ensure();
    await writeFile(store.paths.config, JSON.stringify({
      tenant: 'feishu',
      appId: 'app',
      tmuxBinary: 'tmux',
      agentBinaries: { codex: 'codex', 'trae-cli': 'trae-cli', 'claude-code': 'claude' },
      pollIntervalMs: 650,
    }));
    await writeFile(store.paths.state, JSON.stringify({
      schemaVersion: 2,
      sessions: {
        helix: { id: 'helix', agent: 'trae-cli', sessionName: 'lca-helix', paneId: '%2', cwd: '/work', agentVersion: '0.201', updatedAt: 1 },
        docs: { id: 'docs', agent: 'claude-code', sessionName: 'lca-docs', paneId: '%3', cwd: '/docs', agentVersion: '2.1', updatedAt: 2 },
      },
      activeSessionId: 'helix',
      updatedAt: 3,
    }));

    expect((await store.loadConfig())?.agentBinaries).toEqual({
      codex: 'codex', traex: 'trae-cli', claude: 'claude',
    });
    const state = await store.loadState();
    expect(state.sessions?.helix?.agent).toBe('traex');
    expect(state.sessions?.docs?.agent).toBe('claude');
  });
});
