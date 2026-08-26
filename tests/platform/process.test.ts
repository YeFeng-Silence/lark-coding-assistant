import { describe, expect, it } from 'vitest';
import { runFile } from '../../src/platform/process.js';

describe('runFile cancellation', () => {
  it('terminates the child process when the startup transaction is aborted', async () => {
    const controller = new AbortController();
    const startedAt = Date.now();
    const command = runFile(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      timeoutMs: 10_000,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(new Error('startup deadline exceeded')), 30);
    await expect(command).rejects.toMatchObject({ code: 'ABORT_ERR' });
    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });
});
