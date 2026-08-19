import { homedir } from 'node:os';
import { join } from 'node:path';

export interface AppPaths {
  root: string;
  config: string;
  secrets: string;
  state: string;
  logsDir: string;
  logFile: string;
  runtimeDir: string;
  socket: string;
  pid: string;
}

export function resolveAppPaths(root = process.env.LARK_CODING_ASSISTANT_HOME): AppPaths {
  const base = root || join(homedir(), '.lark-coding-assistant');
  return {
    root: base,
    config: join(base, 'config.json'),
    secrets: join(base, 'secrets.json'),
    state: join(base, 'state.json'),
    logsDir: join(base, 'logs'),
    logFile: join(base, 'logs', 'assistant.log'),
    runtimeDir: join(base, 'runtime'),
    socket: join(base, 'runtime', 'daemon.sock'),
    pid: join(base, 'runtime', 'daemon.pid'),
  };
}
