import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runFile, runFileWithInput } from '../../src/platform/process.js';
import { TmuxController } from '../../src/tmux/controller.js';
vi.mock('../../src/platform/process.js', () => ({ runFile: vi.fn(), runFileWithInput: vi.fn() }));
beforeEach(() => {
  vi.useFakeTimers(); vi.mocked(runFile).mockReset().mockResolvedValue({ stdout: '', stderr: '' });
  vi.mocked(runFileWithInput).mockReset().mockResolvedValue({ stdout: '', stderr: '' });
});
afterEach(() => vi.useRealTimers());
const enters = () => vi.mocked(runFile).mock.calls.filter(([, args]) => args[0] === 'send-keys');
describe('paste submission', () => {
  it('requests bracketed paste and sends exactly one Enter after the paste guard', async () => {
    const operation = new TmuxController().sendText('%1', 'one\ntwo');
    await vi.advanceTimersByTimeAsync(299);
    expect(runFile).toHaveBeenCalledWith('tmux', expect.arrayContaining(['paste-buffer', '-p']));
    expect(enters()).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1); await operation;
    expect(enters().map(([, args]) => args)).toEqual([['send-keys', '-t', '%1', 'Enter']]);
  });
  it('does not submit or wait when only typing is requested', async () => {
    await new TmuxController().sendText('%1', 'draft', false);
    expect(enters()).toHaveLength(0); expect(vi.getTimerCount()).toBe(0);
  });
  it('keeps consecutive message pastes serialized through submission', async () => {
    const controller = new TmuxController();
    const a = controller.sendText('%1', 'first'); const b = controller.sendText('%1', 'second');
    await vi.advanceTimersByTimeAsync(299);
    expect(runFileWithInput).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(enters()).toHaveLength(1); expect(runFileWithInput).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(300); await Promise.all([a,b]);
    expect(enters()).toHaveLength(2);
  });
  it('does not submit when paste fails', async () => {
    vi.mocked(runFile).mockImplementation(async (_file, args) => {
      if (args[0] === 'paste-buffer') throw new Error('paste failed');
      return { stdout: '', stderr: '' };
    });
    await expect(new TmuxController().sendText('%1', 'hello')).rejects.toThrow('paste failed');
    expect(enters()).toHaveLength(0);
  });
});
