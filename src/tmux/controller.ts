import { randomBytes } from 'node:crypto';
import { runFile, runFileWithInput } from '../platform/process.js';
import { assertSafeTmuxTarget, sanitizeRemoteInput, shellQuote } from './input.js';
import type { TmuxCreateOptions, TmuxInspectResult, TmuxPane, TmuxSessionMetadata } from './types.js';
import { AppError } from '../core/errors.js';

const PANE_FORMAT = '#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_start_command}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_dead}\t#{pane_dead_status}\t#{cursor_x}\t#{cursor_y}';
const METADATA_OPTIONS = {
  managed: '@lca-managed',
  sessionId: '@lca-session-id',
  agent: '@lca-agent',
  cwd: '@lca-cwd',
  agentVersion: '@lca-agent-version',
  agentSessionId: '@lca-agent-session-id',
} as const;

export class TmuxController {
  private writes: Promise<void> = Promise.resolve();

  constructor(readonly binary = 'tmux') {}

  async version(): Promise<string> {
    return (await runFile(this.binary, ['-V'])).stdout.trim();
  }

  async create(options: TmuxCreateOptions): Promise<TmuxPane> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(options.sessionName)) {
      throw new AppError(
        'INVALID_SESSION_NAME',
        'tmux session name must contain only letters, digits, underscore, or dash',
        { sessionId: options.sessionName },
      );
    }
    if (await this.hasSession(options.sessionName)) {
      throw new AppError(
        'SESSION_EXISTS',
        `tmux session already exists: ${options.sessionName}`,
        { sessionId: displaySessionId(options.sessionName), source: 'tmux' },
      );
    }
    const environment = Object.entries(options.env ?? {}).map(([key, value]) => {
      if (!/^[A-Z][A-Z0-9_]*$/.test(key)) throw new Error(`unsafe tmux environment key: ${key}`);
      return `${key}=${value}`;
    });
    const command = [
      ...(environment.length > 0 ? ['/usr/bin/env', ...environment] : []),
      options.binary,
      ...(options.args ?? []),
    ].map(shellQuote).join(' ');
    const createArgs = [
      'new-session', '-d', '-s', options.sessionName, '-c', options.cwd,
      '-x', '120', '-y', '40', command,
    ];
    if (options.preserveOnExit) {
      createArgs.push(';', 'set-option', '-w', '-t', `=${options.sessionName}:`, 'remain-on-exit', 'on');
    }
    await runFile(this.binary, createArgs);
    const pane = await this.findBySession(options.sessionName);
    if (!pane) throw new Error('tmux created a session without a discoverable pane');
    return pane;
  }

  async hasSession(sessionName: string): Promise<boolean> {
    try {
      await runFile(this.binary, ['has-session', '-t', `=${sessionName}`]);
      return true;
    } catch {
      return false;
    }
  }

  async findBySession(sessionName: string): Promise<TmuxPane | undefined> {
    const { stdout } = await runFile(this.binary, [
      'list-panes', '-t', `=${sessionName}`, '-F', PANE_FORMAT,
    ]);
    return stdout.split('\n').map(parsePane).find(Boolean);
  }

  async inspect(paneId: string): Promise<TmuxPane | undefined> {
    const result = await this.inspectStatus(paneId);
    return result.status === 'live' || result.status === 'dead' ? result.pane : undefined;
  }

  async inspectStatus(paneId: string): Promise<TmuxInspectResult> {
    assertSafeTmuxTarget(paneId);
    try {
      const { stdout } = await runFile(this.binary, [
        'display-message', '-p', '-t', paneId, PANE_FORMAT,
      ]);
      if (!stdout.trim()) return { status: 'missing' };
      const pane = parsePane(stdout.trim());
      if (!pane) return { status: 'unavailable', error: new Error('invalid tmux pane response') };
      return pane.dead ? { status: 'dead', pane } : { status: 'live', pane };
    } catch (error) {
      return tmuxTargetMissing(error) ? { status: 'missing' } : { status: 'unavailable', error };
    }
  }

  async inspectSession(sessionName: string): Promise<TmuxInspectResult> {
    try {
      const pane = await this.findBySession(sessionName);
      if (!pane) return { status: 'missing' };
      return pane.dead ? { status: 'dead', pane } : { status: 'live', pane };
    } catch (error) {
      return tmuxTargetMissing(error) ? { status: 'missing' } : { status: 'unavailable', error };
    }
  }

  async listSessions(prefix: string): Promise<TmuxPane[]> {
    const { stdout } = await runFile(this.binary, ['list-panes', '-a', '-F', PANE_FORMAT]);
    return stdout.split('\n')
      .map(parsePane)
      .filter((pane): pane is TmuxPane => Boolean(pane?.sessionName.startsWith(prefix)));
  }

  async writeMetadata(sessionName: string, metadata: TmuxSessionMetadata): Promise<void> {
    const values: Partial<Record<keyof typeof METADATA_OPTIONS, string>> = {
      managed: '1',
      sessionId: metadata.sessionId,
      agent: metadata.agent,
      cwd: metadata.cwd,
      agentVersion: metadata.agentVersion,
      agentSessionId: metadata.agentSessionId,
    };
    for (const [key, option] of Object.entries(METADATA_OPTIONS) as [keyof typeof METADATA_OPTIONS, string][]) {
      const value = values[key];
      if (value === undefined) {
        await runFile(this.binary, ['set-option', '-u', '-t', sessionName, option]).catch(() => undefined);
      } else {
        await runFile(this.binary, ['set-option', '-t', sessionName, option, value]);
      }
    }
  }

  async readMetadata(sessionName: string): Promise<TmuxSessionMetadata | undefined> {
    const values: Partial<Record<keyof typeof METADATA_OPTIONS, string>> = {};
    for (const [key, option] of Object.entries(METADATA_OPTIONS) as [keyof typeof METADATA_OPTIONS, string][]) {
      const result = await runFile(this.binary, ['show-options', '-t', sessionName, '-v', option]).catch(() => undefined);
      if (!result) {
        if (key === 'agentSessionId') continue;
        return undefined;
      }
      values[key] = result.stdout.trim();
    }
    if (values.managed !== '1' || !values.sessionId || !values.cwd || !values.agentVersion
      || (values.agent !== 'codex' && values.agent !== 'traex' && values.agent !== 'claude')) return undefined;
    return {
      managed: true,
      sessionId: values.sessionId,
      agent: values.agent,
      cwd: values.cwd,
      agentVersion: values.agentVersion,
      agentSessionId: values.agentSessionId || undefined,
    };
  }

  async capture(paneId: string, lines = 200): Promise<string> {
    assertSafeTmuxTarget(paneId);
    const { stdout } = await runFile(this.binary, [
      'capture-pane', '-p', '-J', '-e', '-t', paneId, '-S', `-${Math.max(1, lines)}`,
    ]);
    return stdout;
  }

  async preserveOnExit(sessionName: string, enabled: boolean): Promise<void> {
    await runFile(this.binary, [
      'set-option', '-w', '-t', `=${sessionName}:`, 'remain-on-exit', enabled ? 'on' : 'off',
    ]);
  }

  sendText(paneId: string, input: string, submit = true): Promise<void> {
    assertSafeTmuxTarget(paneId);
    const text = sanitizeRemoteInput(input);
    if (!text.trim()) return Promise.reject(new Error('message is empty after sanitization'));
    const operation = async (): Promise<void> => {
      const bufferName = `lca-${process.pid}-${randomBytes(6).toString('hex')}`;
      await runFileWithInput(this.binary, ['load-buffer', '-b', bufferName, '-'], text);
      try {
        await runFile(this.binary, ['paste-buffer', '-b', bufferName, '-d', '-t', paneId]);
      } finally {
        await runFile(this.binary, ['delete-buffer', '-b', bufferName]).catch(() => undefined);
      }
      if (submit) await runFile(this.binary, ['send-keys', '-t', paneId, 'Enter']);
    };
    this.writes = this.writes.then(operation, operation);
    return this.writes;
  }

  async sendKey(paneId: string, key: string): Promise<void> {
    assertSafeTmuxTarget(paneId);
    if (!/^(Enter|Escape|Space|Tab|BSpace|Up|Down|Left|Right|PPage|NPage|C-c|C-u|C-k|C-Enter|[yandpcq1-9])$/.test(key)) {
      throw new Error(`unsupported tmux key: ${key}`);
    }
    await runFile(this.binary, ['send-keys', '-t', paneId, key]);
  }

  async killSession(sessionName: string): Promise<void> {
    try {
      await runFile(this.binary, ['kill-session', '-t', `=${sessionName}`]);
    } catch (error) {
      if (!tmuxTargetMissing(error)) throw error;
    }
  }
}

function displaySessionId(sessionName: string): string {
  return sessionName.replace(/^lark-coding-assistant-/, '');
}

function parsePane(line: string): TmuxPane | undefined {
  const [sessionName, paneId, pidText, startCommand, currentCommand, cwd, deadText, exitStatusText, cursorXText, cursorYText] = line.trim().split('\t');
  const pid = Number(pidText);
  const cursorX = Number(cursorXText);
  const cursorY = Number(cursorYText);
  if (!sessionName || !paneId || !Number.isInteger(pid) || !startCommand || !currentCommand || (!cwd && deadText !== '1')
    || !Number.isInteger(cursorX) || !Number.isInteger(cursorY)) return undefined;
  const exitStatus = exitStatusText === '' ? undefined : Number(exitStatusText);
  return {
    sessionName, paneId, pid, startCommand, currentCommand, cwd: cwd || '/', dead: deadText === '1',
    exitStatus: Number.isInteger(exitStatus) ? exitStatus : undefined,
    cursorX, cursorY,
  };
}

function tmuxTargetMissing(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const stderr = error && typeof error === 'object' && 'stderr' in error ? String(error.stderr) : '';
  return /can't find (?:pane|session|window)|no such (?:pane|session|window)|(?:pane|session|window) not found|no server running/i.test(`${message}\n${stderr}`);
}
