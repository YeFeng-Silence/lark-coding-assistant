import { AGENT_IDS } from './agents/types.js';
import type { SessionState } from './core/model.js';
import type { RuntimeSessionStatus } from './daemon/protocol.js';

export interface CliDaemonSummary {
  status: 'running' | 'unresponsive' | 'stopped';
  pid?: number;
  version?: string;
}

export interface CliStatusReport {
  daemon: CliDaemonSummary;
  cliVersion: string;
  state: SessionState;
  sessions: RuntimeSessionStatus[];
  requestedSessionId?: string;
  columns?: number;
}

interface StatusRow {
  current: string;
  agent: string;
  session: string;
  status: string;
  tmux: string;
  cwd: string;
}

const HEADERS: Array<keyof StatusRow> = ['current', 'agent', 'session', 'status', 'tmux', 'cwd'];
const LABELS: StatusRow = {
  current: '当前',
  agent: 'Agent',
  session: 'Session',
  status: '状态',
  tmux: 'tmux',
  cwd: '工作目录',
};

export function formatCliStatus(report: CliStatusReport): string {
  const daemon = [
    `Daemon: ${report.daemon.status}`,
    ...(report.daemon.pid ? [`PID ${report.daemon.pid}`] : []),
    ...(report.daemon.version ? [`daemon ${report.daemon.version}`] : []),
    `CLI ${report.cliVersion}`,
  ].join(' · ');
  const sessions = [...report.sessions].sort(compareRuntimeSessions);
  if (report.requestedSessionId && sessions.length === 0) {
    return `${daemon}\nSessions: 0\n\n未找到 session「${sanitize(report.requestedSessionId)}」，请运行 lca status 查看全部 session。`;
  }
  if (sessions.length === 0) return `${daemon}\nSessions: 0\n\n暂无受管 session。`;
  const rows = sessions.map(toStatusRow);
  return `${daemon}\nSessions: ${rows.length}\n\n${renderTable(rows, report.columns ?? 120)}`;
}

export function fallbackRuntimeSessions(state: SessionState, requestedSessionId?: string): RuntimeSessionStatus[] {
  return Object.values(state.sessions ?? {})
    .filter(({ id }) => !requestedSessionId || id === requestedSessionId)
    .map((session) => ({
      session,
      active: session.id === state.activeSessionId,
    }));
}

function compareRuntimeSessions(left: RuntimeSessionStatus, right: RuntimeSessionStatus): number {
  const agent = AGENT_IDS.indexOf(left.session.agent) - AGENT_IDS.indexOf(right.session.agent);
  return agent || left.session.id.localeCompare(right.session.id);
}

function toStatusRow(runtime: RuntimeSessionStatus): StatusRow {
  return {
    current: runtime.active ? '●' : '',
    agent: runtime.session.agent,
    session: runtime.session.id,
    status: runtimeStatusLabel(runtime),
    tmux: runtime.paneAlive === undefined ? '无法确认' : runtime.paneAlive ? '运行中' : '已停止',
    cwd: runtime.session.cwd,
  };
}

function runtimeStatusLabel(runtime: RuntimeSessionStatus): string {
  if (runtime.paneAlive === undefined) return '无法确认';
  if (!runtime.paneAlive || runtime.screen?.state === 'exited') return '已停止';
  if (runtime.screen?.state === 'failed') return '执行失败';
  if (runtime.screen?.interaction?.kind === 'approval') return '等待审批';
  if (runtime.screen?.interaction?.kind === 'question') return '等待回答';
  if (runtime.screen?.interaction?.kind === 'choice') return '等待选择';
  if (runtime.screen?.state === 'input') return '等待输入';
  if (runtime.screen?.state === 'running') return '执行中';
  if (runtime.screen?.state === 'starting') return '启动中';
  if (runtime.screen?.state === 'idle') return '等待用户输入';
  return '状态未知';
}

function renderTable(rows: StatusRow[], terminalColumns: number): string {
  const desired = HEADERS.map((key) => Math.max(
    displayWidth(LABELS[key]),
    ...rows.map((row) => displayWidth(sanitize(row[key]))),
  ));
  const widths = [
    desired[0] ?? 4,
    desired[1] ?? 6,
    Math.min(desired[2] ?? 7, 24),
    desired[3] ?? 4,
    desired[4] ?? 4,
    desired[5] ?? 8,
  ];
  const fixedWidth = widths.slice(0, -1).reduce((sum, width) => sum + width, 0);
  const tableOverhead = HEADERS.length * 3 + 1;
  const cwdAvailable = terminalColumns - fixedWidth - tableOverhead;
  widths[5] = Math.max(18, Math.min(widths[5] ?? 18, cwdAvailable));

  const border = (left: string, middle: string, right: string): string =>
    `${left}${widths.map((width) => '─'.repeat(width + 2)).join(middle)}${right}`;
  const line = (row: StatusRow): string => `│${HEADERS.map((key, index) => {
    const value = sanitize(row[key]);
    const width = widths[index] ?? 0;
    return ` ${fit(value, width, key === 'cwd')} `;
  }).join('│')}│`;

  return [
    border('┌', '┬', '┐'),
    line(LABELS),
    border('├', '┼', '┤'),
    ...rows.map(line),
    border('└', '┴', '┘'),
  ].join('\n');
}

function fit(value: string, width: number, middle = false): string {
  const fitted = displayWidth(value) <= width
    ? value
    : middle
      ? truncateMiddle(value, width)
      : `${takeStart(value, Math.max(0, width - 1))}…`;
  return `${fitted}${' '.repeat(Math.max(0, width - displayWidth(fitted)))}`;
}

function truncateMiddle(value: string, width: number): string {
  if (width <= 1) return '…'.slice(0, width);
  const remaining = width - 1;
  const leftWidth = Math.ceil(remaining / 2);
  return `${takeStart(value, leftWidth)}…${takeEnd(value, remaining - leftWidth)}`;
}

function takeStart(value: string, width: number): string {
  let result = '';
  let used = 0;
  for (const character of value) {
    const characterWidth = displayWidth(character);
    if (used + characterWidth > width) break;
    result += character;
    used += characterWidth;
  }
  return result;
}

function takeEnd(value: string, width: number): string {
  let result = '';
  let used = 0;
  for (const character of [...value].reverse()) {
    const characterWidth = displayWidth(character);
    if (used + characterWidth > width) break;
    result = character + result;
    used += characterWidth;
  }
  return result;
}

function displayWidth(value: string): number {
  let width = 0;
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (/\p{Mark}/u.test(character)) continue;
    width += isWide(code) ? 2 : 1;
  }
  return width;
}

function isWide(code: number): boolean {
  return code >= 0x1100 && (
    code <= 0x115f
    || code === 0x2329 || code === 0x232a
    || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f)
    || (code >= 0xac00 && code <= 0xd7a3)
    || (code >= 0xf900 && code <= 0xfaff)
    || (code >= 0xfe10 && code <= 0xfe19)
    || (code >= 0xfe30 && code <= 0xfe6f)
    || (code >= 0xff00 && code <= 0xff60)
    || (code >= 0xffe0 && code <= 0xffe6)
    || (code >= 0x1f300 && code <= 0x1faff)
    || (code >= 0x20000 && code <= 0x3fffd)
  );
}

function sanitize(value: string): string {
  return value
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .trim();
}
