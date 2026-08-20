import { execFile } from 'node:child_process';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AppError } from '../src/core/errors.js';
import { formatCliError } from '../src/cli-errors.js';

describe('CLI error formatting', () => {
  it('renders duplicate sessions with actionable commands', () => {
    const output = formatCliError(new AppError(
      'SESSION_EXISTS',
      'managed coding-agent session is already running: assistant',
      { sessionId: 'assistant', operation: 'start' },
    ));
    expect(output).toContain('无法启动 session「assistant」：该 session 已在运行');
    expect(output).toContain('lark-coding-assistant attach assistant');
    expect(output).toContain('lark-coding-assistant start --name <新名称>');
    expect(output).not.toContain('at ');
  });

  it.each([
    ['SESSION_NOT_FOUND', { sessionId: 'api' }, '找不到 session「api」'],
    ['INVALID_SESSION_NAME', { sessionId: 'bad name' }, 'session 名称「bad name」无效'],
    ['NOT_INITIALIZED', {}, 'lark-coding-assistant init'],
    ['INVALID_CWD', { cwd: '/missing' }, '工作目录不可用：/missing'],
    ['BINARY_NOT_FOUND', { binary: 'codex' }, '找不到所需命令：codex'],
    ['INVALID_OPTIONS', { reason: '参数冲突' }, '命令参数无效：参数冲突'],
    ['DAEMON_UNAVAILABLE', {}, 'lark-coding-assistant daemon restart'],
    ['REQUEST_TIMEOUT', {}, 'bridge daemon 未及时响应'],
    ['UNKNOWN', { operation: 'start' }, '操作失败：启动 session 时发生异常'],
  ] as const)('renders %s', (code, context, expected) => {
    expect(formatCliError(new AppError(code, 'internal detail', context))).toContain(expected);
  });

  it('sanitizes untrusted context and only includes stacks in debug mode', () => {
    const cause = new Error('low-level failure');
    const error = new AppError('INVALID_CWD', 'bad cwd', { cwd: '/tmp/ok\nFAKE' }, { cause });
    expect(formatCliError(error)).toContain('工作目录不可用：/tmp/ok FAKE');
    expect(formatCliError(error)).not.toContain('low-level failure');
    const debug = formatCliError(error, true);
    expect(debug).toContain('调试信息：');
    expect(debug).toContain('low-level failure');
    expect(debug).toContain('Caused by:');
  });
});

describe('CLI process error boundary', () => {
  it('prints a safe missing-session error without an uncaught stack', async () => {
    const home = await mkdtemp(join(tmpdir(), 'lca-cli-error-'));
    const result = await runCli(['attach', 'missing'], home);
    expect(result.code).toBe(1);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('找不到 session「missing」');
    expect(result.stderr).not.toContain('at Command');
    expect(result.stderr).not.toContain('Node.js v');
  });

  it('prints the original stack only when debug mode is enabled', async () => {
    const home = await mkdtemp(join(tmpdir(), 'lca-cli-debug-'));
    const result = await runCli(['attach', 'missing'], home, { LARK_CODING_ASSISTANT_DEBUG: '1' });
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('找不到 session「missing」');
    expect(result.stderr).toContain('调试信息：');
    expect(result.stderr).toContain('at attachLocal');
  });

  it('classifies invalid cwd, conflicting options, and missing initialization', async () => {
    const home = await mkdtemp(join(tmpdir(), 'lca-cli-classify-'));
    const invalidCwd = await runCli(['start', '--cwd', join(home, 'missing')], home);
    expect(invalidCwd.stderr).toContain('工作目录不可用');
    expect(invalidCwd.stderr).not.toContain('Node.js v');

    const conflicting = await runCli(['start', '--resume', '--resume-last'], home);
    expect(conflicting.stderr).toContain('命令参数无效');
    expect(conflicting.stderr).toContain('不能同时使用');

    const notInitialized = await runCli(['start', '--cwd', home], home);
    expect(notInitialized.stderr).toContain('尚未完成初始化');
    expect(notInitialized.stderr).toContain('lark-coding-assistant init');
  });

  it('classifies daemon connection failures without exposing socket errors', async () => {
    const home = await mkdtemp(join(tmpdir(), 'lca-cli-daemon-'));
    const result = await runCli(['stop', 'missing'], home);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain('无法连接 bridge daemon');
    expect(result.stderr).not.toContain('ENOENT');
    expect(result.stderr).not.toContain('connect');
  });
});

function runCli(
  args: string[],
  home: string,
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const tsx = resolve('node_modules/.bin/tsx');
  return new Promise((resolveResult, reject) => {
    const child = execFile(tsx, ['src/cli.ts', ...args], {
      cwd: process.cwd(),
      env: { ...process.env, ...extraEnv, LARK_CODING_ASSISTANT_HOME: home },
    }, (error, stdout, stderr) => {
      if (error && !('code' in error)) {
        reject(error);
        return;
      }
      resolveResult({
        code: error && 'code' in error && typeof error.code === 'number' ? error.code : 0,
        stdout,
        stderr,
      });
    });
    child.stdin?.end();
  });
}
