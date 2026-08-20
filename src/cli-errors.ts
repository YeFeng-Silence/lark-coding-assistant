import { AppError, asAppError, type ErrorContext } from './core/errors.js';

export function withCliOperation(error: unknown, operation: string | undefined): AppError {
  return asAppError(error, 'UNKNOWN', operation ? { operation } : {});
}

export function formatCliError(error: unknown, debug = false): string {
  const appError = asAppError(error);
  const context = appError.context;
  const lines = formatKnownError(appError, context);
  if (!debug) return lines.join('\n');
  return [...lines, '', '调试信息：', debugStack(appError)].join('\n');
}

export function cliDebugEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.LARK_CODING_ASSISTANT_DEBUG === '1';
}

function formatKnownError(error: AppError, context: ErrorContext): string[] {
  const sessionId = safeValue(context.sessionId, 'default');
  switch (error.code) {
    case 'SESSION_EXISTS':
      return [
        `无法启动 session「${sessionId}」：该 session 已在运行。`,
        '',
        '你可以：',
        `  lark-coding-assistant attach ${sessionId}`,
        '  lark-coding-assistant start --name <新名称>',
      ];
    case 'SESSION_NOT_FOUND':
      return [
        `找不到 session「${sessionId}」。`,
        '',
        '请先查看或创建 session：',
        '  lark-coding-assistant status',
        `  lark-coding-assistant start --name ${sessionId}`,
      ];
    case 'INVALID_SESSION_NAME':
      return [
        `session 名称「${safeValue(context.sessionId, '')}」无效。`,
        '名称只能包含字母、数字、下划线和短横线，长度为 1–40 个字符。',
      ];
    case 'NOT_INITIALIZED':
      return ['尚未完成初始化。', '', '请运行：', '  lark-coding-assistant init'];
    case 'INVALID_CWD':
      return [
        `工作目录不可用：${safeValue(context.cwd, '未知目录')}`,
        '',
        '请检查目录是否存在且有访问权限，或重新指定 --cwd。',
      ];
    case 'BINARY_NOT_FOUND':
      return [
        `找不到所需命令：${safeValue(context.binary, '未知命令')}`,
        '',
        '请先安装该命令，或检查 PATH 和初始化配置。',
      ];
    case 'INVALID_OPTIONS':
      return [
        `命令参数无效：${safeValue(context.reason, error.message)}`,
        '',
        '请运行 lark-coding-assistant --help 查看可用参数。',
      ];
    case 'DAEMON_UNAVAILABLE':
      return [
        '无法连接 bridge daemon。',
        '',
        '请尝试：',
        '  lark-coding-assistant daemon restart',
        '  lark-coding-assistant logs',
      ];
    case 'REQUEST_TIMEOUT':
      return [
        'bridge daemon 未及时响应。',
        '',
        '请尝试：',
        '  lark-coding-assistant daemon status',
        '  lark-coding-assistant daemon restart',
        '  lark-coding-assistant logs',
      ];
    case 'UNKNOWN':
      return [
        `操作失败：${operationLabel(context.operation)} 时发生异常。`,
        '',
        '请尝试：',
        '  lark-coding-assistant status',
        '  lark-coding-assistant logs',
        '',
        '需要查看完整错误：',
        '  LARK_CODING_ASSISTANT_DEBUG=1 lark-coding-assistant ...',
      ];
  }
}

function operationLabel(value: ErrorContext[string]): string {
  const labels: Record<string, string> = {
    init: '初始化',
    start: '启动 session',
    attach: '连接 session',
    'bind-code': '生成绑定码',
    status: '读取状态',
    stop: '停止 session',
    logs: '读取日志',
    'reset-owner': '重置 owner',
    daemon: '管理 bridge daemon',
  };
  return typeof value === 'string' ? labels[value] ?? '执行命令' : '执行命令';
}

function safeValue(value: ErrorContext[string], fallback: string): string {
  if (typeof value !== 'string' && typeof value !== 'number' && typeof value !== 'boolean') return fallback;
  const normalized = String(value).replace(/[\u0000-\u001f\u007f\u009b]|\u001b\[[0-?]*[ -/]*[@-~]/g, ' ').trim();
  return normalized.slice(0, 160) || fallback;
}

function debugStack(error: Error): string {
  const values: string[] = [];
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    values.push(current.stack ?? `${current.name}: ${current.message}`);
    current = current.cause;
  }
  return values.join('\nCaused by:\n');
}
