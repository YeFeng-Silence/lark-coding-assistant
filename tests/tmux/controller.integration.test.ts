import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runFile } from '../../src/platform/process.js';
import { TmuxController } from '../../src/tmux/controller.js';

const sessions: string[] = [];

afterEach(async () => {
  await Promise.all(sessions.splice(0).map((name) => runFile('tmux', ['kill-session', '-t', `=${name}`]).catch(() => undefined)));
});

describe.runIf(await hasTmux())('TmuxController integration', () => {
  it('creates, writes to, captures, and preserves a detached session', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lca-tmux-'));
    const fixture = join(directory, 'fake-codex.mjs');
    await writeFile(fixture, [
      "import { createInterface } from 'node:readline';",
      "console.log('FAKE_CODEX_READY');",
      "console.log('HOOK_SESSION:' + process.env.LARK_CODING_ASSISTANT_SESSION_ID);",
      "const rl = createInterface({ input: process.stdin });",
      "rl.on('line', (line) => console.log(`RECEIVED:${line}`));",
    ].join('\n'));
    const sessionName = `lca-test-${process.pid}-${Date.now()}`;
    sessions.push(sessionName);
    const tmux = new TmuxController();

    try {
      const pane = await tmux.create({
        sessionName,
        cwd: directory,
        binary: process.execPath,
        args: [fixture],
        env: { LARK_CODING_ASSISTANT_SESSION_ID: 'tmux-test-session' },
      });
      expect(pane.paneId).toMatch(/^%\d+$/);
      await tmux.writeMetadata(sessionName, {
        managed: true,
        sessionId: 'tmux-test-session',
        agent: 'codex',
        cwd: directory,
        agentVersion: 'test-version',
        agentSessionId: 'native-session',
      });
      expect(await tmux.readMetadata(sessionName)).toEqual({
        managed: true,
        sessionId: 'tmux-test-session',
        agent: 'codex',
        cwd: directory,
        agentVersion: 'test-version',
        agentSessionId: 'native-session',
      });
      const startupRecovery = {
        phase: 'manual' as const, resume: { mode: 'picker' as const }, previousSessionId: 'previous',
        previousPaneId: '%1', activationRevision: 4,
      };
      const metadata = (await tmux.readMetadata(sessionName))!;
      await tmux.writeMetadata(sessionName, { ...metadata, startupRecovery });
      expect((await tmux.readMetadata(sessionName))?.startupRecovery).toEqual(startupRecovery);
      await tmux.writeMetadata(sessionName, metadata);
      expect((await tmux.readMetadata(sessionName))?.startupRecovery).toBeUndefined();
      await waitFor(async () => (await tmux.capture(pane.paneId, 30)).includes('HOOK_SESSION:tmux-test-session'));
      await tmux.sendText(pane.paneId, 'hello from remote');
      await waitFor(async () => (await tmux.capture(pane.paneId, 30)).includes('RECEIVED:hello from remote'));
      await tmux.sendText(pane.paneId, 'test123', false);
      await waitFor(async () => (await tmux.capture(pane.paneId, 30)).includes('test123'));
      await tmux.sendKey(pane.paneId, 'BSpace');
      await tmux.sendKey(pane.paneId, 'BSpace');
      await tmux.sendKey(pane.paneId, 'BSpace');
      await waitFor(async () => {
        const output = await tmux.capture(pane.paneId, 30);
        return output.includes('test') && !output.includes('test123');
      });
      expect(await tmux.hasSession(sessionName)).toBe(true);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('preserves a multiline bracketed paste and submits once outside the TUI suppression window', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'lca-paste-'));
    const fixture = join(directory, 'paste.mjs');
    const resultFile = join(directory, 'result.json');
    await writeFile(fixture, `
import { writeFileSync } from 'node:fs';
process.stdin.setRawMode(true);
process.stdin.setEncoding('utf8');
process.stdin.resume();
process.stdout.write('\\x1b[?2004hREADY');
let pending = '', pasted = '', pastedAt = 0, enters = 0, suppressed = 0;
process.stdin.on('data', (chunk) => {
  pending += chunk;
  const begin = '\\x1b[200~', end = '\\x1b[201~';
  if (pending.startsWith(begin)) {
    const index = pending.indexOf(end);
    if (index < 0) return;
    pasted = pending.slice(begin.length, index);
    pastedAt = Date.now();
    pending = pending.slice(index + end.length);
  }
  for (const ch of pending) {
    if (ch !== '\\r') continue;
    enters++;
    const elapsed = Date.now() - pastedAt;
    if (elapsed < 120) suppressed++;
    writeFileSync(${JSON.stringify(resultFile)}, JSON.stringify({ pasted, enters, suppressed, elapsed }));
  }
  pending = '';
});
`);
    const sessionName = `lca-paste-${process.pid}-${Date.now()}`;
    sessions.push(sessionName);
    const tmux = new TmuxController();
    try {
      const pane = await tmux.create({ sessionName, cwd: directory, binary: process.execPath, args: [fixture] });
      await waitFor(async () => (await tmux.capture(pane.paneId)).includes('READY'));
      await tmux.sendText(pane.paneId, 'first line\n第二行');
      await waitFor(async () => readFile(resultFile, 'utf8').then(() => true, () => false));
      const result = JSON.parse(await readFile(resultFile, 'utf8'));
      expect(result).toMatchObject({ pasted: 'first line\n第二行', enters: 1, suppressed: 0 });
      expect(result.elapsed).toBeGreaterThanOrEqual(120);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('preserves startup exit status and terminal output', async () => {
    const sessionName = `lca-dead-${process.pid}-${Date.now()}`;
    sessions.push(sessionName);
    const tmux = new TmuxController();
    const pane = await tmux.create({
      sessionName,
      cwd: tmpdir(),
      binary: process.execPath,
      args: ['-e', "console.log('STARTUP_FAILURE_DETAIL'); process.exit(7)"],
      preserveOnExit: true,
    });
    await waitFor(async () => (await tmux.inspect(pane.paneId))?.dead === true);
    const exited = await tmux.inspect(pane.paneId);
    expect(exited).toMatchObject({ dead: true });
    expect([7, undefined]).toContain(exited?.exitStatus);
    expect(await tmux.capture(pane.paneId, 20)).toContain('STARTUP_FAILURE_DETAIL');
  });
});

async function hasTmux(): Promise<boolean> {
  return runFile('tmux', ['-V']).then(() => true, () => false);
}

async function waitFor(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error('timed out waiting for tmux output');
}
