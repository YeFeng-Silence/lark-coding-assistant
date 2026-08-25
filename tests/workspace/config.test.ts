import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AppConfig } from '../../src/core/model.js';
import { addWorkspaceRoot, listWorkspaceRoots, removeWorkspaceRoot } from '../../src/workspace/config.js';

const baseConfig = (): AppConfig => ({
  tenant: 'feishu', appId: 'app', tmuxBinary: 'tmux',
  agentBinaries: { codex: 'codex', traex: 'trae-cli', claude: 'claude' },
  pollIntervalMs: 650, workspaceRoots: [],
});

describe('workspace config', () => {
  it('adds, deduplicates, lists, and removes normalized roots', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lca-workspace-config-'));
    const added = await addWorkspaceRoot(baseConfig(), '.', root);
    expect(added).toMatchObject({ path: root, added: true });
    const duplicate = await addWorkspaceRoot(added.config, `${root}/.`);
    expect(duplicate.added).toBe(false);
    expect(listWorkspaceRoots(duplicate.config)).toEqual([root]);
    const removed = removeWorkspaceRoot(duplicate.config, '.', root);
    expect(removed.removed).toBe(true);
    expect(removed.config.workspaceRoots).toEqual([]);
  });

  it('rejects an unavailable root and reports a missing removal without mutation', async () => {
    await expect(addWorkspaceRoot(baseConfig(), '/definitely/missing/lca-root')).rejects.toMatchObject({ code: 'INVALID_CWD' });
    const result = removeWorkspaceRoot(baseConfig(), '/tmp/not-configured');
    expect(result.removed).toBe(false);
  });
});
