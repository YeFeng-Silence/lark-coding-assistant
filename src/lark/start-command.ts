import { normalizeAgentId } from '../agents/types.js';
import type { AgentResume } from '../agents/types.js';
import { AppError } from '../core/errors.js';
import type { StartSessionRequest } from '../session/start-request.js';

export function parseStartCommand(input: string): StartSessionRequest {
  const tokens = tokenize(input);
  if (tokens[0] !== '/start') throw invalid('命令必须以 /start 开头');
  const sessionId = tokens[1];
  if (!sessionId || sessionId.startsWith('--')) throw invalid('请提供 session 名称');

  let agentValue: string | undefined;
  let cwd: string | undefined;
  let resume: AgentResume | undefined;
  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token === '--agent') {
      if (agentValue !== undefined) throw invalid('--agent 不能重复');
      agentValue = requiredValue(tokens, ++index, '--agent');
      continue;
    }
    if (token === '--cwd') {
      if (cwd !== undefined) throw invalid('--cwd 不能重复');
      cwd = requiredValue(tokens, ++index, '--cwd');
      continue;
    }
    if (token === '--resume-last') {
      throw invalid('飞书端不支持 --resume-last，请使用 --resume 打开原生 Resume Picker');
    }
    if (token === '--resume') {
      if (resume) throw invalid('只能选择一种恢复方式');
      const candidate = tokens[index + 1];
      if (candidate && !candidate.startsWith('--')) {
        throw invalid('飞书端不支持输入历史 Session ID，请使用 --resume 打开原生 Resume Picker');
      }
      resume = { mode: 'picker' };
      continue;
    }
    throw invalid(`无法识别参数：${token}`);
  }

  const agent = agentValue ? normalizeAgentId(agentValue) : undefined;
  if (!agentValue) throw invalid('请提供 --agent');
  if (!agent) throw invalid(`不支持的 agent：${agentValue}；可选 codex、traex、claude`);
  if (!cwd) throw invalid('请提供 --cwd');
  return { sessionId, agent, cwd, resume };
}

export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let current = '';
  let quote: "'" | '"' | undefined;
  let escaped = false;
  const push = (): void => {
    if (current) tokens.push(current);
    current = '';
  };
  for (const char of input.trim()) {
    if (escaped) {
      current += char;
      escaped = false;
    } else if (char === '\\' && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (char === quote) quote = undefined;
      else current += char;
    } else if (char === "'" || char === '"') {
      quote = char;
    } else if (/\s/.test(char)) {
      push();
    } else {
      current += char;
    }
  }
  if (escaped) current += '\\';
  if (quote) throw invalid('引号没有闭合');
  push();
  return tokens;
}

function requiredValue(tokens: string[], index: number, option: string): string {
  const value = tokens[index];
  if (!value || value.startsWith('--')) throw invalid(`${option} 缺少参数值`);
  return value;
}

function invalid(reason: string): AppError {
  return new AppError('INVALID_OPTIONS', reason, { reason });
}
