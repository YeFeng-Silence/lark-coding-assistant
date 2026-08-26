import { describe, expect, it } from 'vitest';
import { SessionStartCoordinator } from '../../src/session/start-coordinator.js';

const descriptor = {
  sessionId: 'helix',
  agent: 'traex' as const,
  cwd: '/work/helix',
  source: 'cli' as const,
};

describe('SessionStartCoordinator', () => {
  it('aborts at the hard deadline, cleans once, and releases the session name', async () => {
    const logs: string[] = [];
    const coordinator = new SessionStartCoordinator(40, async (line) => { logs.push(line); });
    let cleaned = 0;
    let aborted = false;
    const first = coordinator.run(
      descriptor,
      async ({ signal, stage }) => stage('agent-version', () => new Promise<string>((_resolve, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true;
          reject(signal.reason);
        }, { once: true });
      })),
      async () => { cleaned += 1; },
    );
    await new Promise((resolve) => setTimeout(resolve, 5));
    const duplicate = await coordinator.run(descriptor, async () => 'duplicate', async () => undefined);
    expect(duplicate).toMatchObject({ ok: false, error: { code: 'SESSION_STARTING' } });

    const timedOut = await first;
    expect(timedOut).toMatchObject({
      ok: false,
      error: {
        code: 'SESSION_START_TIMEOUT',
        context: { sessionId: 'helix', agent: 'traex', cwd: '/work/helix', stage: 'agent-version', timeoutMs: 40 },
      },
    });
    expect(aborted).toBe(true);
    expect(cleaned).toBe(1);
    expect(logs.some((line) => line.includes('session start timed out'))).toBe(true);

    const retry = await coordinator.run(descriptor, async () => 'ready', async () => undefined);
    expect(retry).toEqual({ ok: true, value: 'ready' });
  });

  it('cleans explicit failures without replacing their error code', async () => {
    const coordinator = new SessionStartCoordinator(100);
    let cleanedCode = '';
    const result = await coordinator.run(
      descriptor,
      async ({ stage }) => stage('tmux-create', async () => {
        throw new Error('tmux failed');
      }),
      async (_context, error) => { cleanedCode = error.code; },
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'START_FAILED', context: { stage: 'tmux-create' } } });
    expect(cleanedCode).toBe('START_FAILED');
  });

  it('allows different session names to start concurrently', async () => {
    const coordinator = new SessionStartCoordinator(200);
    let running = 0;
    let peak = 0;
    const execute = async (): Promise<string> => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 25));
      running -= 1;
      return 'ready';
    };
    const [helix, docs] = await Promise.all([
      coordinator.run(descriptor, execute, async () => undefined),
      coordinator.run({ ...descriptor, sessionId: 'docs', agent: 'claude' }, execute, async () => undefined),
    ]);
    expect(helix.ok).toBe(true);
    expect(docs.ok).toBe(true);
    expect(peak).toBe(2);
  });
});
