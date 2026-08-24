import { describe, expect, it } from 'vitest';
import { parseStartCommand, tokenize } from '../../src/lark/start-command.js';

describe('parseStartCommand', () => {
  it('parses canonical agents, quoted cwd, and new sessions', () => {
    expect(parseStartCommand('/start helix --agent traex --cwd "/Users/feng/My Project"')).toEqual({
      sessionId: 'helix', agent: 'traex', cwd: '/Users/feng/My Project', resume: undefined,
    });
  });

  it('keeps legacy agent aliases compatible', () => {
    expect(parseStartCommand('/start docs --agent claude-code --cwd /work/docs').agent).toBe('claude');
    expect(parseStartCommand('/start app --agent trae-cli --cwd /work/app').agent).toBe('traex');
  });

  it('allows the picker and rejects last or explicit resume modes', () => {
    expect(parseStartCommand('/start one --agent codex --cwd /work --resume').resume).toEqual({ mode: 'picker' });
    expect(() => parseStartCommand('/start two --agent codex --cwd /work --resume-last')).toThrow(
      '飞书端不支持 --resume-last',
    );
    expect(() => parseStartCommand('/start three --agent codex --cwd /work --resume abc')).toThrow(
      '飞书端不支持输入历史 Session ID',
    );
  });

  it('rejects unknown, conflicting, and unclosed input without shell execution', () => {
    expect(() => parseStartCommand('/start one --agent codex --cwd /work --bad')).toThrow('无法识别参数');
    expect(() => parseStartCommand('/start one --agent codex --cwd /work --resume --resume-last')).toThrow(
      '飞书端不支持 --resume-last',
    );
    expect(() => tokenize('/start one --cwd "unterminated')).toThrow('引号没有闭合');
  });
});
