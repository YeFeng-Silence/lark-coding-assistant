import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { normalizeWorkspacePath, validateWorkspaceDirectory } from '../../src/workspace/path.js';

describe('workspace paths', () => {
  it('expands home paths and normalizes absolute paths', () => {
    expect(normalizeWorkspacePath(' ~ ', '/Users/test')).toBe('/Users/test');
    expect(normalizeWorkspacePath('~/workspace/../code', '/Users/test')).toBe('/Users/test/code');
    expect(normalizeWorkspacePath(' /tmp/a/../b ', '/Users/test')).toBe('/tmp/b');
  });

  it('rejects empty, relative, and other-user home paths', () => {
    for (const value of ['', 'relative/path', '~somebody/project']) {
      expect(() => normalizeWorkspacePath(value, '/Users/test')).toThrowError(expect.objectContaining({ code: 'INVALID_CWD' }));
    }
  });

  it('validates existing directories and rejects files', async () => {
    const root = await mkdtemp(join(tmpdir(), 'lca-workspace-path-'));
    const file = join(root, 'file.txt');
    await writeFile(file, 'x');
    await expect(validateWorkspaceDirectory(root)).resolves.toBe(root);
    await expect(validateWorkspaceDirectory(file)).rejects.toMatchObject({ code: 'INVALID_CWD' });
  });
});
