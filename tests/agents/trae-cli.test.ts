import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { detectTraeScreen } from '../../src/screen/detector.js';

describe('Trae CLI terminal fixtures', () => {
  it.each([
    ['trust', 'input'],
    ['idle', 'idle'],
    ['running', 'running'],
    ['input', 'input'],
    ['approval', 'approval'],
    ['failed', 'failed'],
  ] as const)('detects %s as %s', async (fixture, state) => {
    const raw = (await readFile(new URL(`./fixtures/trae/${fixture}.txt`, import.meta.url), 'utf8'))
      .replaceAll('\\u001b', '\u001b');
    expect(detectTraeScreen(raw).state).toBe(state);
  });

  it('detects an exited Trae pane independently of terminal text', () => {
    expect(detectTraeScreen('', false).state).toBe('exited');
  });
});
