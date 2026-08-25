import type { RecentWorkspace } from '../core/model.js';
import { normalizeWorkspacePath } from './path.js';

export function rememberRecentWorkspace(
  existing: readonly RecentWorkspace[] | undefined,
  cwd: string,
  now = Date.now(),
  limit = 30,
): RecentWorkspace[] {
  const normalized = normalizeWorkspacePath(cwd);
  return [
    { cwd: normalized, lastUsedAt: now },
    ...(existing ?? []).filter((item) => normalizeWorkspacePath(item.cwd) !== normalized),
  ].slice(0, limit);
}
