import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveNativeAgentSessionId } from '../../src/session/native-session.js';

describe('native agent session discovery', () => {
  it('maps a live traex peer pid to its native thread id', async () => {
    const home = await mkdtemp(join(tmpdir(), 'lca-native-session-'));
    const directory = join(home, '.trae', 'cli', 'session-peers');
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, 'peer.json'), JSON.stringify({ pid: 4242, threadId: 'traex-thread' }));
    expect(await resolveNativeAgentSessionId('traex', 4242, home)).toBe('traex-thread');
    expect(await resolveNativeAgentSessionId('traex', 4343, home)).toBeUndefined();
  });
});
