import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
