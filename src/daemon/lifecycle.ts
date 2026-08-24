import { mkdir, open, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { AppPaths } from '../core/paths.js';
import { runFile } from '../platform/process.js';
import { requestDaemon } from './client.js';
import type { DaemonInfo } from './protocol.js';
import { AppError } from '../core/errors.js';

export type DaemonHealth =
  | { status: 'running'; info: DaemonInfo }
  | { status: 'unresponsive'; pid: number }
  | { status: 'stopped' };

export interface DaemonHealthProbe {
  ping(paths: AppPaths, timeoutMs: number): Promise<DaemonInfo | undefined>;
  readPid(paths: AppPaths): Promise<number>;
  processIsAlive(pid: number): boolean;
  isCurrentDaemonProcess(pid: number): Promise<boolean>;
  wait(ms: number): Promise<void>;
}

export async function daemonInfo(paths: AppPaths, timeoutMs = 500): Promise<DaemonInfo | undefined> {
  try {
    const response = await requestDaemon(paths.socket, { method: 'ping' }, timeoutMs);
    if (!response.ok) return undefined;
    return isDaemonInfo(response.value) ? response.value : undefined;
  } catch {
    return undefined;
  }
}

export async function startDaemonProcess(
  paths: AppPaths,
  daemonEntry: string,
  readyTimeoutMs = 5_000,
): Promise<DaemonInfo> {
  const existing = await daemonInfo(paths);
  if (existing) return existing;
  const health = await daemonHealth(paths);
  if (health.status === 'running') return health.info;
  if (health.status === 'unresponsive') {
    throw new AppError('DAEMON_UNRESPONSIVE', 'daemon process is alive but its control socket is unresponsive', {
      pid: health.pid,
    });
  }
  await Promise.all([
    mkdir(paths.runtimeDir, { recursive: true, mode: 0o700 }),
    mkdir(paths.logsDir, { recursive: true, mode: 0o700 }),
  ]);
  const log = await open(paths.logFile, 'a', 0o600);
  const child = spawn(process.execPath, [daemonEntry], {
    detached: true,
    stdio: ['ignore', log.fd, log.fd],
    env: process.env,
  });
  let spawnError: Error | undefined;
  child.once('error', (error) => { spawnError = error; });
  await log.close();
  child.unref();
  const deadline = Date.now() + readyTimeoutMs;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    await delay(100);
    const info = await daemonInfo(paths, 300);
    if (info) return info;
  }
  throw new Error('daemon did not become ready');
}

export async function daemonHealth(paths: AppPaths, probe: DaemonHealthProbe = defaultHealthProbe): Promise<DaemonHealth> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const info = await probe.ping(paths, 400);
    if (info) return { status: 'running', info };
    if (attempt < 2) await probe.wait(80);
  }
  const pid = await probe.readPid(paths);
  if (validPid(pid) && probe.processIsAlive(pid) && await probe.isCurrentDaemonProcess(pid)) {
    return { status: 'unresponsive', pid };
  }
  return { status: 'stopped' };
}

const defaultHealthProbe: DaemonHealthProbe = {
  ping: daemonInfo,
  readPid: async (paths) => Number.parseInt(await readFile(paths.pid, 'utf8').catch(() => ''), 10),
  processIsAlive,
  isCurrentDaemonProcess,
  wait: delay,
};

export async function stopDaemonProcess(paths: AppPaths): Promise<boolean> {
  const info = await daemonInfo(paths);
  if (!info) return stopDaemonByPid(paths);
  try {
    const response = await requestDaemon(paths.socket, { method: 'shutdown' }, 1_000);
    if (!response.ok) throw new Error(response.error);
  } catch {
    signalDaemon(info.pid);
  }
  await waitUntilStopped(paths, info.pid);
  return true;
}

async function stopDaemonByPid(paths: AppPaths): Promise<boolean> {
  const pid = Number.parseInt(await readFile(paths.pid, 'utf8').catch(() => ''), 10);
  if (!validPid(pid) || !processIsAlive(pid)) return false;
  if (!await isCurrentDaemonProcess(pid)) {
    throw new Error(`PID ${pid} is alive but is not a lark-coding-assistant daemon; refusing to signal it`);
  }
  signalDaemon(pid);
  await waitUntilStopped(paths, pid);
  return true;
}

async function isCurrentDaemonProcess(pid: number): Promise<boolean> {
  try {
    const command = (await runFile('ps', ['-p', String(pid), '-o', 'command='])).stdout.trim();
    return command.includes('lark-coding-assistant')
      && /(?:^|\/)daemon-entry\.js(?:\s|$)/.test(command);
  } catch {
    return false;
  }
}

async function waitUntilStopped(paths: AppPaths, pid: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (!processIsAlive(pid) && !await daemonInfo(paths, 200)) return;
    await delay(100);
  }
  throw new Error(`daemon PID ${pid} did not stop within 5 seconds`);
}

function signalDaemon(pid: number): void {
  if (!validPid(pid) || pid === process.pid) throw new Error('refusing to signal invalid daemon PID');
  process.kill(pid, 'SIGTERM');
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && 'code' in error && error.code === 'EPERM';
  }
}

function validPid(pid: number): boolean {
  return Number.isInteger(pid) && pid > 1;
}

function isDaemonInfo(value: unknown): value is DaemonInfo {
  if (!value || typeof value !== 'object') return false;
  const info = value as Record<string, unknown>;
  return typeof info.version === 'string' && typeof info.pid === 'number';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
