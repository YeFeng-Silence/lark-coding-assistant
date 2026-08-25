import { describe, expect, it } from 'vitest';
import { rememberRecentWorkspace } from '../../src/workspace/recent.js';

describe('recent workspaces', () => {
  it('refreshes duplicates and caps entries', () => {
    const existing = Array.from({ length: 30 }, (_, index) => ({ cwd: `/tmp/project-${index}`, lastUsedAt: 30 - index }));
    const refreshed = rememberRecentWorkspace(existing, '/tmp/project-5/.', 100);
    expect(refreshed).toHaveLength(30);
    expect(refreshed[0]).toEqual({ cwd: '/tmp/project-5', lastUsedAt: 100 });
    expect(refreshed.filter((item) => item.cwd === '/tmp/project-5')).toHaveLength(1);
  });
});
