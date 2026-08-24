import { describe, expect, it, vi } from 'vitest';
import { daemonHealth, type DaemonHealthProbe } from '../../src/daemon/lifecycle.js';
import { resolveAppPaths } from '../../src/core/paths.js';

describe('daemon health', () => {
  const paths = resolveAppPaths('/tmp/lca-health-test');

  it('reports running after a transient ping timeout', async () => {
    const probe = fakeProbe();
    probe.ping = vi.fn()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce({ pid: 42, version: '1.0.0' });
    await expect(daemonHealth(paths, probe)).resolves.toEqual({
      status: 'running', info: { pid: 42, version: '1.0.0' },
    });
    expect(probe.wait).toHaveBeenCalledOnce();
  });

  it('distinguishes an unresponsive LCA process from a stopped daemon', async () => {
    const unresponsive = fakeProbe();
    await expect(daemonHealth(paths, unresponsive)).resolves.toEqual({ status: 'unresponsive', pid: 42 });

    const stopped = fakeProbe();
    stopped.processIsAlive = () => false;
    await expect(daemonHealth(paths, stopped)).resolves.toEqual({ status: 'stopped' });
  });
});

function fakeProbe(): DaemonHealthProbe {
  return {
    ping: vi.fn().mockResolvedValue(undefined),
    readPid: vi.fn().mockResolvedValue(42),
    processIsAlive: () => true,
    isCurrentDaemonProcess: vi.fn().mockResolvedValue(true),
    wait: vi.fn().mockResolvedValue(undefined),
  };
}
