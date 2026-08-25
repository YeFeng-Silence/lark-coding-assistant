import { lstat, readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, relative } from 'node:path';
import type { ManagedSession, RecentWorkspace } from '../core/model.js';
import { normalizeWorkspacePath } from './path.js';

export type WorkspaceCandidateSource = 'active' | 'recent' | 'configured';

export interface WorkspaceCandidate {
  cwd: string;
  label: string;
  source: WorkspaceCandidateSource;
  git: boolean;
}

export interface WorkspaceDiscoveryResult {
  candidates: WorkspaceCandidate[];
  partial: boolean;
  warnings: string[];
  visitedDirectories: number;
}

export interface DiscoverWorkspaceOptions {
  workspaceRoots: readonly string[];
  activeSessions: readonly ManagedSession[];
  recentWorkspaces: readonly RecentWorkspace[];
  maxDepth?: number;
  maxDirectories?: number;
  timeBudgetMs?: number;
  now?: () => number;
  home?: string;
}

export async function discoverWorkspaces(options: DiscoverWorkspaceOptions): Promise<WorkspaceDiscoveryResult> {
  const maxDepth = options.maxDepth ?? 1;
  const maxDirectories = options.maxDirectories ?? 500;
  const timeBudgetMs = options.timeBudgetMs ?? 2_000;
  const now = options.now ?? Date.now;
  const home = options.home ?? homedir();
  const startedAt = now();
  const warnings: string[] = [];
  const byPath = new Map<string, WorkspaceCandidate>();
  let visitedDirectories = 0;
  let partial = false;

  const budgetAvailable = (): boolean => {
    const available = visitedDirectories < maxDirectories && now() - startedAt <= timeBudgetMs;
    if (!available) partial = true;
    return available;
  };
  const add = async (input: string, source: WorkspaceCandidateSource): Promise<void> => {
    if (!budgetAvailable()) return;
    let cwd: string;
    try {
      cwd = normalizeWorkspacePath(input, home);
    } catch {
      return;
    }
    if (byPath.has(cwd)) return;
    visitedDirectories += 1;
    try {
      const info = await lstat(cwd);
      if (!info.isDirectory() || info.isSymbolicLink()) return;
      byPath.set(cwd, { cwd, label: workspaceLabel(cwd, home), source, git: await hasGitEntry(cwd) });
    } catch {
      if (source === 'configured') warnings.push(`无法读取 workspace：${cwd}`);
    }
  };

  for (const session of options.activeSessions) await add(session.cwd, 'active');
  for (const recent of [...options.recentWorkspaces].sort((a, b) => b.lastUsedAt - a.lastUsedAt)) {
    await add(recent.cwd, 'recent');
  }
  for (const rootInput of options.workspaceRoots) {
    if (!budgetAvailable()) break;
    let root: string;
    try {
      root = normalizeWorkspacePath(rootInput, home);
      const info = await lstat(root);
      if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('not a directory');
    } catch {
      warnings.push(`无法读取 workspace：${rootInput}`);
      continue;
    }
    await add(root, 'configured');
    let frontier = [root];
    for (let depth = 1; depth <= maxDepth && frontier.length > 0 && budgetAvailable(); depth += 1) {
      const next: string[] = [];
      for (const parent of frontier) {
        if (!budgetAvailable()) break;
        let entries;
        try {
          entries = await readdir(parent, { withFileTypes: true });
        } catch {
          warnings.push(`无法读取目录：${parent}`);
          continue;
        }
        for (const entry of entries) {
          if (!budgetAvailable()) break;
          if (!entry.isDirectory() || entry.isSymbolicLink() || entry.name.startsWith('.')) continue;
          const child = join(parent, entry.name);
          await add(child, 'configured');
          if (depth < maxDepth) next.push(child);
        }
      }
      frontier = next;
    }
  }

  const priority: Record<WorkspaceCandidateSource, number> = { active: 0, recent: 1, configured: 2 };
  const candidates = [...byPath.values()].sort((left, right) =>
    priority[left.source] - priority[right.source]
    || Number(right.git) - Number(left.git)
    || left.label.localeCompare(right.label, 'zh-CN'),
  );
  return { candidates, partial, warnings: [...new Set(warnings)], visitedDirectories };
}

export function workspaceLabel(cwd: string, home = homedir()): string {
  const parent = dirname(cwd);
  const rel = relative(home, parent);
  const displayParent = rel === '' ? '~' : !rel.startsWith('..') ? `~/${rel}` : parent;
  return `${basename(cwd) || cwd} · ${displayParent}`;
}

async function hasGitEntry(cwd: string): Promise<boolean> {
  return stat(join(cwd, '.git')).then(() => true).catch(() => false);
}
