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
    case 'SESSION_STARTING':
      return [
        `session「${sessionId}」正在启动，请等待当前操作完成。`,
        '',
        '稍后可查看状态：',
        `  lark-coding-assistant status ${sessionId}`,
      ];
    case 'SESSION_START_TIMEOUT': {
      const excerpt = safeValue(context.terminalExcerpt, 'Agent 未输出可用错误信息。');
      return [
        `session「${sessionId}」启动超过 30 秒，已取消并清理。`,
        '',
        `Agent：${safeValue(context.agent, '未知')}`,
        `工作目录：${safeValue(context.cwd, '未知')}`,
        `超时阶段：${safeValue(context.stage, 'unknown')}`,
        '',
        '最近终端输出：',
        excerpt,
        '',
        '可以直接使用同名 session 重试。',
      ];
    }
    case 'AGENT_SESSION_IN_USE': {
      const ownerSessionId = safeValue(context.ownerSessionId, '现有 session');
      const agentSessionId = typeof context.agentSessionId === 'string'
        ? safeValue(context.agentSessionId, '')
        : undefined;
      return [
        `无法启动 session「${sessionId}」：对应的 Agent 原生 session 已由「${ownerSessionId}」连接。`,
        ...(agentSessionId ? ['', `原生 session ID：${agentSessionId}`] : []),
        '',
        '请直接连接现有 session：',
        `  lark-coding-assistant attach ${ownerSessionId}`,
      ];
    }
    case 'AGENT_EXITED_DURING_STARTUP': {
      const exitStatus = typeof context.exitStatus === 'number' ? `（退出码 ${context.exitStatus}）` : '';
      return [
        `Agent 启动后立即退出${exitStatus}，session「${sessionId}」未创建。`,
        '',
        '原始错误：',
        safeValue(context.terminalExcerpt, 'Agent 未输出可用错误信息。'),
        '',
        '可查看日志或改为启动新会话：',
        '  lark-coding-assistant logs',
        `  lark-coding-assistant start --name ${sessionId} --agent ${safeValue(context.agent, 'codex')}`,
      ];
    }
    case 'AGENT_IDENTITY_TIMEOUT':
      return [
        `无法确认恢复目标，session「${sessionId}」未创建。`,
        'Agent 仍在运行，但 LCA 未能识别原生 session ID。',
        '',
        '临时 tmux 已清理，请查看日志后重试或启动新会话：',
        '  lark-coding-assistant logs',
        `  lark-coding-assistant start --name ${sessionId} --agent ${safeValue(context.agent, 'codex')}`,
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
    case 'INVALID_RESUME':
      return [
        `恢复参数无效：${safeValue(context.reason, error.message)}`,
        '',
        '请只选择一种恢复方式，并检查历史 session ID。',
      ];
    case 'START_FAILED':
      return [
        `无法启动 session「${sessionId}」。`,
        '',
        '请检查工作目录、Agent 安装和 daemon 日志：',
        '  lark-coding-assistant logs',
      ];
    case 'DAEMON_UNAVAILABLE':
      return [
        '无法连接 bridge daemon。',
        '',
        '请尝试：',
        '  lark-coding-assistant daemon restart',
        '  lark-coding-assistant logs',
      ];
    case 'DAEMON_UNRESPONSIVE':
      return [
        'bridge daemon 进程仍在运行，但控制通道无响应。',
        '',
        '请重启 daemon；现有 coding-agent/tmux sessions 会保留：',
        '  lark-coding-assistant daemon restart',
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
    workspace: '管理 workspace',
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
