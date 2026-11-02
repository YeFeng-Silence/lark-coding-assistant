import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveAppPaths } from '../../src/core/paths.js';
import { performMaintenance, readUpdateStatus, compareVersions } from '../../src/update/manager.js';
import { runFile } from '../../src/platform/process.js';
import { daemonInfo, startDaemonProcess, stopDaemonProcess } from '../../src/daemon/lifecycle.js';
vi.mock('../../src/platform/process.js', () => ({ runFile: vi.fn() }));
vi.mock('../../src/daemon/lifecycle.js', () => ({ daemonInfo: vi.fn(), startDaemonProcess: vi.fn(), stopDaemonProcess: vi.fn() }));
vi.mock('../../src/daemon/client.js', () => ({ requestDaemon: vi.fn() }));
let root: string;
let pkg: string;
beforeEach(async () => {
  vi.resetAllMocks();
  root = await mkdtemp(join(tmpdir(), 'lca-update-'));
  pkg = join(root, 'modules', 'lark-coding-assistant');
  await mkdir(pkg, { recursive: true });
  await mkdir(join(root, 'runtime'));
  await writeFile(join(pkg, 'package.json'), '{"version":"0.2.10"}');
  vi.mocked(daemonInfo).mockResolvedValue(undefined);
  vi.mocked(startDaemonProcess).mockResolvedValue({ version: '0.2.11', pid: 123 });
  vi.mocked(runFile).mockImplementation(async (_file, args) => {
    if (args[0] === 'root') return { stdout: join(root, 'modules'), stderr: '' };
    if (args[0] === 'view') return { stdout: '"0.2.11"', stderr: '' };
    await writeFile(join(pkg, 'package.json'), JSON.stringify({ version: String(args[2]).split('@')[1] }));
    return { stdout: '', stderr: '' };
  });
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });
describe('package maintenance', () => {
  it('installs before stopping the old daemon, then starts the installed version', async () => {
    await performMaintenance(resolveAppPaths(root), pkg, 'update');
    expect((await readUpdateStatus(resolveAppPaths(root)))?.phase).toBe('success');
    expect(vi.mocked(runFile).mock.invocationCallOrder.at(-1)).toBeLessThan(vi.mocked(stopDaemonProcess).mock.invocationCallOrder[0]!);
    expect(startDaemonProcess).toHaveBeenCalled();
  });
  it('does not restart or downgrade when already newer than npm', async () => {
    await writeFile(join(pkg, 'package.json'), '{"version":"0.2.12"}');
    await performMaintenance(resolveAppPaths(root), pkg, 'update');
    expect(stopDaemonProcess).not.toHaveBeenCalled();
    expect((await readUpdateStatus(resolveAppPaths(root)))?.phase).toBe('success');
  });
  it('keeps the running daemon when installation fails and restores the old package', async () => {
    const normal = vi.mocked(runFile).getMockImplementation()!;
    vi.mocked(runFile).mockImplementation(async (file, args, options) => {
      if (args[2] === 'lark-coding-assistant@0.2.11') throw new Error('install failed');
      return normal(file, args, options);
    });
    await performMaintenance(resolveAppPaths(root), pkg, 'update');
    expect(stopDaemonProcess).not.toHaveBeenCalled();
    expect((await readUpdateStatus(resolveAppPaths(root)))?.phase).toBe('failed');
    expect(runFile).toHaveBeenCalledWith('npm', expect.arrayContaining(['lark-coding-assistant@0.2.10']), expect.anything());
  });
  it('rolls back when the new daemon cannot start', async () => {
    vi.mocked(startDaemonProcess).mockRejectedValueOnce(new Error('startup failed')).mockResolvedValueOnce({ version: '0.2.10', pid: 124 });
    await performMaintenance(resolveAppPaths(root), pkg, 'update');
    expect(startDaemonProcess).toHaveBeenCalledTimes(2);
    expect((await readUpdateStatus(resolveAppPaths(root)))?.message).toContain('已恢复版本 0.2.10');
  });
  it('rejects source checkouts without modifying the global package', async () => {
    vi.mocked(runFile).mockResolvedValueOnce({ stdout: join(root, 'elsewhere'), stderr: '' });
    await performMaintenance(resolveAppPaths(root), pkg, 'update');
    expect((await readUpdateStatus(resolveAppPaths(root)))?.message).toContain('源码');
    expect(stopDaemonProcess).not.toHaveBeenCalled();
  });
  it('rejects npm link installations', async () => {
    const linked = join(root, 'linked');
    await mkdir(linked);
    await symlink(pkg, join(linked, 'lark-coding-assistant'));
    vi.mocked(runFile).mockResolvedValueOnce({ stdout: linked, stderr: '' });
    await performMaintenance(resolveAppPaths(root), pkg, 'update');
    expect(stopDaemonProcess).not.toHaveBeenCalled();
    expect((await readUpdateStatus(resolveAppPaths(root)))?.phase).toBe('failed');
  });
  it('allows a source checkout restart without npm operations', async () => {
    vi.mocked(startDaemonProcess).mockResolvedValue({ version: '0.2.10', pid: 125 });
    await performMaintenance(resolveAppPaths(root), pkg, 'restart');
    expect(runFile).not.toHaveBeenCalled();
    expect((await readUpdateStatus(resolveAppPaths(root)))?.phase).toBe('success');
  });
  it('compares patch and minor numbers numerically', () => {
    expect(compareVersions('0.2.10', '0.2.9')).toBeGreaterThan(0);
    expect(compareVersions('0.3.0', '0.2.99')).toBeGreaterThan(0);
  });
});
