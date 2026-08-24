import { createHash } from 'node:crypto';
import type { AgentId } from '../agents/types.js';
import { normalizeScreen } from './normalize.js';

export interface ResumePickerOption {
  id: string;
  label: string;
  detail?: string;
  selected: boolean;
  visibleIndex: number;
}

export interface ResumePickerView {
  agent: AgentId;
  fingerprint: string;
  options: ResumePickerOption[];
  selectedIndex: number;
  position?: number;
  total?: number;
  canPrevious: boolean;
  canNext: boolean;
}

export function parseResumePicker(raw: string, agent: AgentId): ResumePickerView | undefined {
  const normalized = normalizeScreen(raw);
  return agent === 'claude'
    ? parseClaudePicker(normalized, agent)
    : parseCodexStylePicker(normalized, agent);
}

function parseCodexStylePicker(normalized: string, agent: AgentId): ResumePickerView | undefined {
  if (!/^\s*Resume a previous session\s*$/mi.test(normalized)) return undefined;
  const lines = normalized.split('\n');
  const start = lines.findIndex((line) => /Type to search/i.test(line));
  const end = lines.findIndex((line, index) => index > start && /enter\s+resume/i.test(line));
  if (start < 0 || end < 0) return undefined;
  const options: ResumePickerOption[] = [];
  for (const line of lines.slice(start + 1, end)) {
    const match = line.match(/^\s*(❯)?\s*(\d+\s*(?:m|h|d|w|mo|y)\s+ago)\s+(.+?)\s*$/i);
    if (!match?.[3]) continue;
    const label = match[3].trim();
    options.push(option(options.length, label, match[2]?.replace(/\s+/g, ''), Boolean(match[1])));
  }
  if (options.length === 0) return undefined;
  const positionMatch = normalized.match(/(\d+)\s*\/\s*(\d+)\s*·\s*(\d+)%/);
  return view(
    agent,
    normalized,
    options,
    positionMatch ? Number(positionMatch[1]) : undefined,
    positionMatch ? Number(positionMatch[2]) : undefined,
  );
}

function parseClaudePicker(normalized: string, agent: AgentId): ResumePickerView | undefined {
  const header = normalized.match(/^\s*Resume session(?:\s*\((\d+)\s+of\s+(\d+)\))?\s*$/mi);
  if (!header) return undefined;
  const lines = normalized.split('\n');
  const start = lines.findIndex((line) => /⌕\s*Search|Search…/i.test(line));
  const end = lines.findIndex((line, index) => index > start && /Ctrl\+A to show all projects/i.test(line));
  if (start < 0 || end < 0) return undefined;
  const options: ResumePickerOption[] = [];
  const body = lines.slice(start + 1, end);
  const navigation = {
    canPrevious: body.some((line) => /^\s*↑/.test(line)),
    canNext: body.some((line) => /^\s*↓/.test(line)),
  };
  for (let index = 0; index < body.length - 1; index += 1) {
    const title = body[index] ?? '';
    const detail = body[index + 1] ?? '';
    if (!/\b(?:minute|hour|day|week|month|year)s? ago\s*·/i.test(detail)) continue;
    const selected = /^\s*❯/.test(title);
    const label = title.replace(/^\s*[❯↓↑]?\s*/, '').trim();
    if (!label || /^[↓↑]/.test(title.trim())) continue;
    options.push(option(options.length, label, detail.trim(), selected));
    index += 1;
  }
  if (options.length === 0) return undefined;
  return view(
    agent,
    normalized,
    options,
    header[1] ? Number(header[1]) : undefined,
    header[2] ? Number(header[2]) : undefined,
    navigation,
  );
}

function option(visibleIndex: number, label: string, detail: string | undefined, selected: boolean): ResumePickerOption {
  const id = createHash('sha256').update(`${visibleIndex}\n${label}\n${detail ?? ''}`).digest('hex').slice(0, 16);
  return { id, label, detail, selected, visibleIndex };
}

function view(
  agent: AgentId,
  normalized: string,
  options: ResumePickerOption[],
  position?: number,
  total?: number,
  navigation?: { canPrevious: boolean; canNext: boolean },
): ResumePickerView {
  const selectedIndex = Math.max(0, options.findIndex((candidate) => candidate.selected));
  const hasHiddenOptions = position !== undefined && total !== undefined && total > options.length;
  return {
    agent,
    fingerprint: createHash('sha256').update(normalized).digest('hex'),
    options,
    selectedIndex,
    position,
    total,
    canPrevious: navigation?.canPrevious || (hasHiddenOptions && position > 1),
    canNext: navigation?.canNext || (hasHiddenOptions && position < total),
  };
}
