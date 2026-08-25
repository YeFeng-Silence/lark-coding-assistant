import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { discoverWorkspaces } from '../../src/workspace/discovery.js';

describe('workspace discovery', () => {
  it('merges sources by priority, deduplicates, scans one level, and sorts git first', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lca-discovery-'));
    const active = join(root, 'active');
    const git = join(root, 'git-project');
    const normal = join(root, 'normal');
    const nested = join(normal, 'nested');
    const tooDeep = join(nested, 'too-deep');
    await Promise.all([
      mkdir(active), mkdir(join(git, '.git'), { recursive: true }), mkdir(tooDeep, { recursive: true }),
    ]);
    const result = await discoverWorkspaces({
      workspaceRoots: [root],
      activeSessions: [{
        id: 'one', agent: 'codex', sessionName: 'lca-one', paneId: '%1', cwd: active,
        agentVersion: 'test', updatedAt: 1,
      }],
      recentWorkspaces: [{ cwd: normal, lastUsedAt: 2 }, { cwd: active, lastUsedAt: 1 }],
      home: root,
    });
    expect(result.candidates[0]?.cwd).toBe(active);
    expect(result.candidates[1]?.cwd).toBe(normal);
    expect(result.candidates.filter((item) => item.cwd === active)).toHaveLength(1);
    expect(result.candidates.find((item) => item.cwd === git)?.git).toBe(true);
    expect(result.candidates.some((item) => item.cwd === nested)).toBe(false);
    expect(result.candidates.some((item) => item.cwd === tooDeep)).toBe(false);
  });

  it('returns partial results when the directory budget is exhausted', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lca-discovery-budget-'));
    await Promise.all(Array.from({ length: 8 }, (_, index) => mkdir(join(root, `p-${index}`))));
    const result = await discoverWorkspaces({
      workspaceRoots: [root], activeSessions: [], recentWorkspaces: [], maxDirectories: 3,
    });
    expect(result.partial).toBe(true);
    expect(result.visitedDirectories).toBe(3);
    expect(result.candidates.length).toBeLessThanOrEqual(3);
  });

  it('skips unreadable or invalid roots while preserving other candidates', async () => {
    const recent = await mkdtemp(join(tmpdir(), 'lca-discovery-recent-'));
    await writeFile(join(recent, '.git'), 'gitdir: elsewhere');
    const result = await discoverWorkspaces({
      workspaceRoots: ['/definitely/missing/lca'], activeSessions: [],
      recentWorkspaces: [{ cwd: recent, lastUsedAt: 1 }],
    });
    expect(result.candidates.map((item) => item.cwd)).toContain(recent);
    expect(result.warnings).toHaveLength(1);
  });
});
