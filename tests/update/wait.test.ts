import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readUpdateStatus } from '../../src/update/manager.js';
import { waitForMaintenance } from '../../src/update/wait.js';
import { resolveAppPaths } from '../../src/core/paths.js';
vi.mock('../../src/update/manager.js', () => ({ readUpdateStatus: vi.fn() }));
const paths = resolveAppPaths('/tmp/lca-wait-test');
const status = (phase: string, pid = 42) => ({ phase, pid, message: phase, updatedAt: 1 });
beforeEach(() => { vi.useFakeTimers(); vi.mocked(readUpdateStatus).mockReset(); vi.spyOn(process, 'kill').mockReturnValue(true); });
afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });
describe('foreground update waiting', () => {
  it('ignores old results, deduplicates progress and returns the current result', async () => {
    vi.mocked(readUpdateStatus).mockResolvedValueOnce(status('failed', 9))
      .mockResolvedValueOnce(status('installing')).mockResolvedValueOnce(status('installing'))
      .mockResolvedValueOnce(status('restarting')).mockResolvedValue(status('success'));
    const report = vi.fn();
    const task = waitForMaintenance(paths, 42, report);
    await vi.advanceTimersByTimeAsync(1500);
    expect(await task).toMatchObject({ phase: 'success' });
    expect(report.mock.calls.map(([s]) => s.phase)).toEqual(['installing', 'restarting', 'success']);
  });
  it('returns a failed result for the CLI to set a nonzero exit code', async () => {
    vi.mocked(readUpdateStatus).mockResolvedValue(status('failed'));
    expect(await waitForMaintenance(paths, 42, vi.fn())).toMatchObject({ phase: 'failed' });
  });
  it('reports an unexpectedly dead worker', async () => {
    vi.mocked(readUpdateStatus).mockResolvedValue(undefined);
    vi.mocked(process.kill).mockImplementation(() => { throw Object.assign(new Error('gone'), { code: 'ESRCH' }); });
    await expect(waitForMaintenance(paths, 42, vi.fn())).rejects.toThrow('意外退出');
  });
  it('bounds waiting without terminating the worker', async () => {
    vi.mocked(readUpdateStatus).mockResolvedValue(status('installing'));
    const task = expect(waitForMaintenance(paths, 42, vi.fn(), 500)).rejects.toThrow('后台任务可能仍在运行');
    await vi.advanceTimersByTimeAsync(600);
    await task;
    expect(process.kill).toHaveBeenCalledWith(42, 0);
  });
});
