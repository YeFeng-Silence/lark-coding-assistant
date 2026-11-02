import { copyFile, mkdir, open, readFile, rename, rm, realpath, lstat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AppPaths } from '../core/paths.js';
import { runFile } from '../platform/process.js';
import { daemonInfo, startDaemonProcess, stopDaemonProcess } from '../daemon/lifecycle.js';
import { requestDaemon } from '../daemon/client.js';

export interface UpdateStatus { phase: string; message: string; updatedAt: number; pid?: number; }
const registry = 'https://registry.npmjs.org';
export const updateFile = (paths: AppPaths) => join(paths.runtimeDir, 'update.json');
export async function readUpdateStatus(paths: AppPaths): Promise<UpdateStatus | undefined> {
  try { return JSON.parse(await readFile(updateFile(paths), 'utf8')); } catch { return undefined; }
}
export async function writeUpdateStatus(paths: AppPaths, status: UpdateStatus): Promise<void> {
  const file = updateFile(paths);
  await writeFile(file + '.tmp', JSON.stringify(status), { mode: 0o600 });
  await rename(file + '.tmp', file);
}
export async function launchMaintenance(paths: AppPaths, action: 'update' | 'restart'): Promise<void> {
  await mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 });
  await mkdir(paths.logsDir, { recursive: true, mode: 0o700 });
  const lock = join(paths.runtimeDir, 'update.lock');
  // Exclusive directory protects CLI and Feishu requests across processes.
  try { await mkdir(lock); } catch {
    const owner = Number(await readFile(join(lock, 'pid'), 'utf8').catch(() => '0'));
    let alive = true;
    if (owner > 1) { try { process.kill(owner, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; } }
    if (alive) throw new Error('已有升级或重启任务在执行；请查看 lca status。');
    await rm(lock, { recursive: true, force: true });
    // A competing request can win this mkdir; never remove its lock.
    await mkdir(lock);
  }
  await writeFile(join(lock, 'pid'), String(process.pid));
  try {
    const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    const worker = join(paths.runtimeDir, 'update-worker.mjs');
    await copyFile(join(packageRoot, 'dist', 'update-entry.js'), worker);
    const log = await open(join(paths.logsDir, 'update.log'), 'a', 0o600);
    const child = spawn(process.execPath, [worker, paths.root, packageRoot, action], {
      detached: true, stdio: ['ignore', log.fd, log.fd], env: process.env,
    });
    const ready = new Promise<void>((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
    await log.close();
    await ready;
    await writeFile(join(lock, 'pid'), String(child.pid));
    child.unref();
  } catch (error) { await rm(lock, { recursive: true, force: true }); throw error; }
}

export async function performMaintenance(paths: AppPaths, packageRoot: string, action: 'update' | 'restart'): Promise<void> {
  const set = (phase: string, message: string) => writeUpdateStatus(paths, { phase, message, updatedAt: Date.now(), pid: process.pid });
  const entry = join(packageRoot, 'dist', 'daemon-entry.js');
  const previous = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version as string;
  let attemptedInstall = false;
  let stopped = false;
  try {
    await set('checking', action === 'update' ? '正在检查 npm 最新版本' : '准备重启 daemon');
    if (action === 'update') {
      const npmRoot = (await runFile('npm', ['root', '-g'])).stdout.trim();
      const expected = join(npmRoot, 'lark-coding-assistant');
      if ((await lstat(expected).catch(() => undefined))?.isSymbolicLink()
        || await realpath(expected).catch(() => '') !== await realpath(packageRoot)) {
        throw new Error('当前从源码或本地链接运行，请通过 npm 全局安装版本执行 lca update；源码可使用 /restart。');
      }
      const latest = JSON.parse((await runFile('npm', ['view', 'lark-coding-assistant', 'version', '--json', '--registry=' + registry], { timeoutMs: 30_000 })).stdout) as string;
      if (!/^\d+\.\d+\.\d+$/.test(latest)) throw new Error('npm 返回了无效的稳定版本号');
      if (compareVersions(latest, previous) <= 0) { await set('success', `已是最新版本 ${previous}，无需重启。`); return; }
      await set('installing', `正在安装 ${latest}，当前 daemon 继续运行`);
      attemptedInstall = true;
      await runFile('npm', ['install', '-g', 'lark-coding-assistant@' + latest, '--registry=' + registry], { timeoutMs: 300_000 });
    }
    await set('restarting', '正在重启 daemon，保留现有 coding-agent/tmux 会话');
    await stopDaemonProcess(paths); stopped = true;
    const info = await startDaemonProcess(paths, entry, 15_000);
    const target = JSON.parse(await readFile(join(packageRoot, 'package.json'), 'utf8')).version;
    if (info.version !== target) throw new Error('重启后的 daemon 版本不符合预期');
    await set('success', `daemon ${info.version} 已启动，现有会话已保留。`);
  } catch (error) {
    let recovery = '';
    if (attemptedInstall) {
      try {
        if (stopped) await stopDaemonProcess(paths);
        await runFile('npm', ['install', '-g', 'lark-coding-assistant@' + previous, '--registry=' + registry], { timeoutMs: 300_000 });
        if (stopped) await startDaemonProcess(paths, entry, 15_000);
        recovery = `已恢复版本 ${previous}。`;
      } catch { recovery = '自动恢复失败，请运行 lca daemon start，查看 logs/update.log。'; }
    } else if (stopped) {
      await startDaemonProcess(paths, entry, 15_000).catch(() => undefined);
    }
    await set('failed', `${error instanceof Error ? error.message : String(error)} ${recovery}`);
  } finally {
    await rm(join(paths.runtimeDir, 'update.lock'), { recursive: true, force: true });
    const result = await readUpdateStatus(paths);
    if (result && await daemonInfo(paths)) {
      await requestDaemon(paths.socket, { method: 'maintenanceComplete', message: result.message }, 10_000).catch(() => undefined);
    }
  }
}

export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number), y = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) { if (x[i] !== y[i]) return x[i]! - y[i]!; }
  return 0;
}
