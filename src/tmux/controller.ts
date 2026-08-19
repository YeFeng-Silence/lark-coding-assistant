import { randomBytes } from 'node:crypto';
import { runFile, runFileWithInput } from '../platform/process.js';
import { assertSafeTmuxTarget, sanitizeRemoteInput, shellQuote } from './input.js';
import type { TmuxCreateOptions, TmuxPane } from './types.js';

const PANE_FORMAT = '#{session_name}\t#{pane_id}\t#{pane_pid}\t#{pane_current_command}\t#{pane_current_path}\t#{pane_dead}\t#{cursor_x}\t#{cursor_y}';

export class TmuxController {
  private writes: Promise<void> = Promise.resolve();

  constructor(readonly binary = 'tmux') {}

  async version(): Promise<string> {
    return (await runFile(this.binary, ['-V'])).stdout.trim();
  }

  async create(options: TmuxCreateOptions): Promise<TmuxPane> {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(options.sessionName)) {
      throw new Error('tmux session name must contain only letters, digits, underscore, or dash');
    }
    if (await this.hasSession(options.sessionName)) {
      throw new Error(`tmux session already exists: ${options.sessionName}`);
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
    await runFile(this.binary, [
      'new-session', '-d', '-s', options.sessionName, '-c', options.cwd,
      '-x', '120', '-y', '40', command,
    ]);
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
    assertSafeTmuxTarget(paneId);
    try {
      const { stdout } = await runFile(this.binary, [
        'display-message', '-p', '-t', paneId, PANE_FORMAT,
      ]);
      return parsePane(stdout.trim());
    } catch {
      return undefined;
    }
  }

  async capture(paneId: string, lines = 200): Promise<string> {
    assertSafeTmuxTarget(paneId);
    const { stdout } = await runFile(this.binary, [
      'capture-pane', '-p', '-J', '-e', '-t', paneId, '-S', `-${Math.max(1, lines)}`,
    ]);
    return stdout;
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
    if (!/^(Enter|Escape|Space|Tab|BSpace|Up|Down|Left|Right|C-c|C-u|C-k|C-Enter|[yandpcq1-9])$/.test(key)) {
      throw new Error(`unsupported tmux key: ${key}`);
    }
    await runFile(this.binary, ['send-keys', '-t', paneId, key]);
  }

  async killSession(sessionName: string): Promise<void> {
    await runFile(this.binary, ['kill-session', '-t', `=${sessionName}`]);
  }
}

function parsePane(line: string): TmuxPane | undefined {
  const [sessionName, paneId, pidText, currentCommand, cwd, deadText, cursorXText, cursorYText] = line.trim().split('\t');
  const pid = Number(pidText);
  const cursorX = Number(cursorXText);
  const cursorY = Number(cursorYText);
  if (!sessionName || !paneId || !Number.isInteger(pid) || !currentCommand || !cwd
    || !Number.isInteger(cursorX) || !Number.isInteger(cursorY)) return undefined;
  return { sessionName, paneId, pid, currentCommand, cwd, dead: deadText === '1', cursorX, cursorY };
}
