import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateStartSessionRequest } from '../../src/session/start-request.js';

describe('validateStartSessionRequest', () => {
  it('accepts a normalized request with an absolute directory', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'lca-start-request-'));
    await expect(validateStartSessionRequest({
      sessionId: 'backend_1', agent: 'traex', cwd, resume: { mode: 'picker' },
    })).resolves.toEqual({
      sessionId: 'backend_1', agent: 'traex', cwd, resume: { mode: 'picker' },
    });
  });

  it('rejects invalid names and relative, missing, or non-directory paths', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'lca-start-invalid-'));
    const file = join(cwd, 'file.txt');
    await writeFile(file, 'x');
    await expect(validateStartSessionRequest({ sessionId: 'bad name', agent: 'codex', cwd }))
      .rejects.toMatchObject({ code: 'INVALID_SESSION_NAME' });
    await expect(validateStartSessionRequest({ sessionId: 'ok', agent: 'codex', cwd: 'relative' }))
      .rejects.toMatchObject({ code: 'INVALID_CWD' });
    await expect(validateStartSessionRequest({ sessionId: 'ok', agent: 'codex', cwd: join(cwd, 'missing') }))
      .rejects.toMatchObject({ code: 'INVALID_CWD' });
    await expect(validateStartSessionRequest({ sessionId: 'ok', agent: 'codex', cwd: file }))
      .rejects.toMatchObject({ code: 'INVALID_CWD' });
  });

  it('rejects an empty explicit resume session id', async () => {
    const cwd = await mkdtemp(join(tmpdir(), 'lca-start-resume-'));
    await expect(validateStartSessionRequest({
      sessionId: 'ok', agent: 'claude', cwd, resume: { mode: 'session', sessionId: '  ' },
    })).rejects.toMatchObject({ code: 'INVALID_RESUME' });
  });
});
