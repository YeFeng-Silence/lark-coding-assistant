import { createHash } from 'node:crypto';
import { normalizeScreen, stripAnsi } from './normalize.js';
import { CLAUDE_DIALECT, CODEX_DIALECT, TRAE_DIALECT } from './dialects.js';
import type { ChoiceInteractionKind, ChoiceRisk, ScreenAction, TerminalDialect } from './interaction-types.js';

export type { ChoiceInteraction, ChoiceInteractionKind, ChoiceRisk, ScreenAction, SelectionSemantics } from './interaction-types.js';

export type ScreenState = 'starting' | 'running' | 'idle' | 'approval' | 'input' | 'failed' | 'exited' | 'unknown';
export interface ScreenDetection {
  state: ScreenState;
  confidence: number;
  normalized: string;
  fingerprint: string;
  evidence: string[];
  actions: ScreenAction[];
  interaction?: import('./interaction-types.js').ChoiceInteraction;
  hasDraftInput: boolean;
}

export function detectCodexScreen(raw: string, paneAlive = true, cursor?: { x: number; y: number }): ScreenDetection {
  return detectAgentScreen(raw, paneAlive, {
    brandPattern: /OpenAI Codex|codex/i,
    brandEvidence: 'codex',
    failurePattern: /fatal error|panicked at|segmentation fault|codex exited/i,
    dialect: CODEX_DIALECT,
  }, cursor);
}

export function detectTraeScreen(raw: string, paneAlive = true, cursor?: { x: number; y: number }): ScreenDetection {
  return detectAgentScreen(raw, paneAlive, {
    brandPattern: /TraeCode CLI|traecli/i,
    brandEvidence: 'trae-cli',
    failurePattern: /fatal error|panicked at|segmentation fault|traecli exited/i,
    dialect: TRAE_DIALECT,
  }, cursor);
}

export function detectClaudeScreen(raw: string, paneAlive = true, cursor?: { x: number; y: number }): ScreenDetection {
  return detectAgentScreen(raw, paneAlive, {
    brandPattern: /Claude Code/i,
    brandEvidence: 'claude-code',
    failurePattern: /fatal error|segmentation fault|Claude Code exited/i,
    dialect: CLAUDE_DIALECT,
  }, cursor);
}

interface AgentScreenOptions {
  brandPattern: RegExp;
  brandEvidence: string;
  failurePattern: RegExp;
  dialect: TerminalDialect;
}

function detectAgentScreen(
  raw: string,
  paneAlive: boolean,
  options: AgentScreenOptions,
  cursor?: { x: number; y: number },
): ScreenDetection {
  const normalized = normalizeScreen(raw);
  const lines = normalized.split('\n').slice(-80);
  const tail = lines.join('\n');
  const bottom = lines.slice(-16);
  const bottomTail = bottom.join('\n');
  const fingerprint = createHash('sha256').update(tail).digest('hex');
  if (!paneAlive) return result('exited', 1, normalized, fingerprint, ['pane exited']);
  if (options.failurePattern.test(bottomTail)) {
    return result('failed', 0.95, normalized, fingerprint, matching(bottom, /fatal|panic|exited/i));
  }

  const choice = parseChoiceInteraction(lines.slice(-60), options.dialect);
  if (choice) {
    const choiceFingerprint = choice.interaction?.interactionId
      ?? createHash('sha256').update(choice.evidence.join('\n')).digest('hex');
    return { ...choice, normalized, fingerprint: choiceFingerprint, hasDraftInput: false };
  }

  const inputEvidence = matching(bottom, /(?:select an option|choose one|enter your answer|provide .*input|request_user_input|do you trust|trust the contents)/i);
  if (inputEvidence.length > 0) return result('input', 0.72, normalized, fingerprint, inputEvidence);

  const activeRunningPattern = /(?:model:\s+loading|esc to interrupt|running\s+.+?hooks?|^\s*[•◦◆◇◈✦✻▍]?\s*(?:working|thinking|executing)(?:…|\s*\(|$))/i;
  const activeRunningEvidence = matching(bottom, activeRunningPattern);
  if (activeRunningEvidence.length > 0) return result('running', 0.85, normalized, fingerprint, activeRunningEvidence);

  const runningPattern = /(?:waiting for)/i;
  const runningEvidence = matching(bottom, runningPattern);
  const lastRunningIndex = lastMatchingIndex(bottom, runningPattern);
  const lastPromptIndex = lastMatchingIndex(bottom, /^\s*[›>❯]\s?/);
  if (lastRunningIndex > lastPromptIndex) return result('running', 0.75, normalized, fingerprint, runningEvidence);
  const promptLines = bottom.slice(-4).filter((line) => /^\s*[›>❯]\s?/.test(line));
  if (promptLines.length > 0) {
    const last = promptLines.at(-1) ?? '';
    const content = last.replace(/^\s*[›>❯]\s?/, '').trim();
    const rawPrompt = raw.split('\n').filter((line) => /^\s*[›>❯]\s?/.test(stripAnsi(line))).at(-1) ?? '';
    const draft = content.length > 0
      && !promptContentIsDim(rawPrompt)
      && !cursorIsAtPromptStart(rawPrompt, cursor?.x);
    return { ...result('idle', 0.8, normalized, fingerprint, [last]), hasDraftInput: draft };
  }

  if (runningEvidence.length > 0) return result('running', 0.75, normalized, fingerprint, runningEvidence);

  if (options.brandPattern.test(tail)) {
    return result('starting', 0.55, normalized, fingerprint, [options.brandEvidence]);
  }
  return result('unknown', 0.2, normalized, fingerprint, []);
}

function cursorIsAtPromptStart(rawLine: string, cursorX?: number): boolean {
  if (cursorX === undefined) return false;
  const visible = stripAnsi(rawLine);
  const marker = visible.search(/[›>❯]/);
  if (marker === -1) return false;
  let contentStart = marker + 1;
  while (/\s/.test(visible[contentStart] ?? '')) contentStart += 1;
  return cursorX === contentStart;
}

function promptContentIsDim(rawLine: string): boolean {
  let dim = false;
  let visible = '';
  const dimAt: boolean[] = [];
  const sgr = /\u001b\[([0-9;]*)m/g;
  let cursor = 0;
  for (const match of rawLine.matchAll(sgr)) {
    const index = match.index ?? cursor;
    const text = rawLine.slice(cursor, index);
    visible += text;
    dimAt.push(...Array.from(text, () => dim));
    const params = (match[1] || '0').split(';').map(Number);
    if (params.includes(0)) dim = false;
    if (params.includes(2)) dim = true;
    if (params.includes(22)) dim = false;
    cursor = index + match[0].length;
  }
  const rest = rawLine.slice(cursor);
  visible += rest;
  dimAt.push(...Array.from(rest, () => dim));
  const marker = visible.search(/[›>❯]/);
  if (marker === -1) return false;
  let contentStart = marker + 1;
  while (/\s/.test(visible[contentStart] ?? '')) contentStart += 1;
  const contentEnd = visible.trimEnd().length;
  return contentEnd > contentStart && dimAt.slice(contentStart, contentEnd).every(Boolean);
}

function parseChoiceInteraction(lines: string[], dialect: TerminalDialect): Omit<ScreenDetection, 'normalized' | 'fingerprint' | 'hasDraftInput'> | undefined {
  const explicitFooterIndex = lastMatchingIndex(lines, new RegExp(dialect.footerPatterns.map(({ source }) => `(?:${source})`).join('|'), 'i'));
  const footerlessHeaderIndex = dialect.footerlessChoiceHeaders
    ? lastMatchingIndex(lines, new RegExp(dialect.footerlessChoiceHeaders.map(({ source }) => `(?:${source})`).join('|'), 'i'))
    : -1;
  if (explicitFooterIndex === -1 && footerlessHeaderIndex === -1) return undefined;
  const footerIndex = explicitFooterIndex >= 0 ? explicitFooterIndex : lines.length;
  if (explicitFooterIndex >= 0 && lines.slice(footerIndex + 1).some((line) => /^\s*[›>❯]\s?/.test(line))) return undefined;
  const allStarts = lines.slice(0, footerIndex)
    .map((line, index) => choiceOptionStart(line) ? index : -1)
    .filter((index) => index >= 0);
  if (allStarts.length < 2) return undefined;
  const optionStarts = latestOptionGroup(allStarts);
  if (optionStarts.length < 2) return undefined;
  if (explicitFooterIndex === -1 && (optionStarts[0] ?? -1) <= footerlessHeaderIndex) return undefined;
  const firstOption = optionStarts[0] ?? 0;
  const beforeOptions = lines.slice(0, firstOption);
  const knownHeader = lastMatchingIndex(beforeOptions, new RegExp(dialect.headerPatterns.map(({ source }) => `(?:${source})`).join('|'), 'i'));
  const hardBoundary = lastMatchingIndex(beforeOptions, /^(?:\s*[-─━═]{8,}\s*|\s*[›>❯]\s+.+|\s*[✻◆◦•]\s+.+)$/);
  const contextStart = knownHeader > hardBoundary
    ? knownHeader
    : hardBoundary >= 0
      ? hardBoundary + 1
      : Math.max(0, firstOption - 12);
  const context = lines.slice(contextStart, firstOption)
    .filter((line) => Boolean(line) && !/^\s*[-─━═]{8,}\s*$/.test(line));
  const footer = lines[footerIndex] ?? '';

  const indexedActions = optionStarts.flatMap((start, optionIndex) => {
    const firstLine = lines[start] ?? '';
    const parsed = parseChoiceOptionLine(firstLine);
    if (!parsed) return [];
    const end = optionStarts[optionIndex + 1] ?? footerIndex;
    const rawLabel = parsed.label;
    const marker = selectionMarker(parsed.marker);
    const segments = [
      rawLabel,
      ...lines.slice(start + 1, end)
        .map((line) => line.trim())
        .filter((line) => Boolean(line)
          && !/^[-─━═]{3,}$/.test(line)
          && !matchesAny(withoutFocusMarker(line), dialect.submitControls)
          && !isSidePanelLine(line)
          && !matchesAny(withoutFocusMarker(line), dialect.customInputControls)
          && !matchesAny(withoutFocusMarker(line), dialect.chatControls)
          && !/^notes$/i.test(line)
          && !/^\[[^\]]+\]$/.test(line)),
    ];
    const shortcutMatch = segments.join(' ').match(/\(([^()\s]{1,16})\)\s*$/);
    if (shortcutMatch) {
      const last = segments.length - 1;
      segments[last] = (segments[last] ?? '').replace(/\s*\([^()\s]{1,16}\)\s*$/, '').trim();
    }
    const parts = (segments.shift() ?? '').split(/\s{2,}/).map((part) => part.trim()).filter(Boolean);
    const label = parts.shift();
    if (!label) return [];
    const continuation = segments.join(' ')
      .replace(/\bnotes:\s*press\s+n\s+to\s+add\s+notes\b/gi, '')
      .trim();
    let description = parts.filter((part) => !isSidePanelLine(part)).join(' ').trim();
    let fullLabel = label;
    if (continuation && marker) {
      description = [description, continuation].filter(Boolean).join(' ');
    } else if (continuation) {
      if (description) description = `${description} ${continuation}`;
      else fullLabel = `${fullLabel} ${continuation}`;
    }
    const role = controlRole(fullLabel, dialect);
    const customValue = role === 'custom-input'
      ? dialect.customInputValuePattern?.exec(fullLabel)?.[1]?.trim()
      : undefined;
    const inputValue = customValue && !/^something\.?$/i.test(customValue) ? customValue : undefined;
    if (role === 'custom-input' && /^type\b/i.test(fullLabel)) fullLabel = 'Type something';
    const risk = choiceRisk(`${fullLabel} ${description}`);
    const editor = role === 'custom-input'
      ? /(?:notes?\s*\(tab\)|tab\s+to\s+(?:add|edit)\s+notes?)/i.test(`${description} ${footer}`)
        ? { openKey: 'Tab', submitKey: 'Enter', commitsInteraction: true }
        : dialect.directInputControls && matchesAny(fullLabel, dialect.directInputControls)
          ? { submitKey: 'Enter', commitsInteraction: true }
          : undefined
      : undefined;
    return [{ index: start, action: {
      id: `option-${parsed.key}`,
      label: fullLabel,
      key: parsed.key,
      description: description || undefined,
      inputValue,
      shortcut: shortcutMatch?.[1]?.toLowerCase(),
      editor,
      focused: parsed.focused,
      marker,
      role,
      risk,
      danger: risk === 'persistent' || risk === 'privileged',
    } satisfies ScreenAction }];
  });
  const standaloneControls = lines.slice(firstOption, footerIndex).flatMap((line, relativeIndex) => {
    const visible = line.replace(/^\s*[›>❯]\s*/, '').trim();
    const role = matchesAny(visible, dialect.submitControls)
      ? 'submit' as const
      : matchesAny(visible, dialect.customInputControls)
        ? 'custom-input' as const
        : matchesAny(visible, dialect.chatControls)
          ? 'chat' as const
          : undefined;
    if (!role) return [];
    const id = role === 'submit' ? 'submit' : role === 'chat' ? 'chat' : 'custom-input';
    const label = /^notes:/i.test(visible) ? 'Add notes' : visible;
    return [{ index: firstOption + relativeIndex, action: {
      id, key: id, label, role, shortcut: /^notes:/i.test(visible) ? 'n' : undefined,
      focused: /^\s*[›>❯]/.test(line), risk: 'normal' as const, danger: false,
    } satisfies ScreenAction }];
  });
  const actions: ScreenAction[] = [...indexedActions, ...standaloneControls]
    .sort((left, right) => left.index - right.index)
    .map(({ action }) => action);
  const submitIndex = actions.findIndex(({ role }) => role === 'submit');
  const inlineCustomIndex = submitIndex - 1;
  const inlineCustom = actions[inlineCustomIndex];
  if (inlineCustom?.role === 'answer'
    && (inlineCustom.marker === 'checked' || inlineCustom.marker === 'unchecked')
    && !inlineCustom.description
    && actions.slice(0, inlineCustomIndex).some(({ description, marker }) => Boolean(description && marker))) {
    const value = inlineCustom.label.trim();
    inlineCustom.role = 'custom-input';
    inlineCustom.inputValue = /^(?:type something|其他|其它|other)$/i.test(value) ? undefined : value;
    inlineCustom.label = 'Type something';
  }
  if (actions.length < 2 || actions.filter(({ focused }) => focused).length !== 1) return undefined;
  const kind = classifyChoice(context, actions, footer);
  const semantics = selectionSemantics(actions, footer);
  const canonical = actions.map(({ key, label, description, role, editor }) => ({ key, label, description, role, editor }));
  const identityContext = context.map((line) => line.replace(/([←\s]*)[☐☑☒]/, '$1☐'));
  const interactionId = createHash('sha256').update(JSON.stringify([kind, identityContext, canonical])).digest('hex');
  const revision = createHash('sha256').update(JSON.stringify([
    interactionId,
    actions.map(({ key, marker, inputValue }) => ({ key, marker, inputValue })),
  ])).digest('hex');
  const questionContext = context.filter((line) => !matchesAny(line, dialect.headerPatterns));
  const questionTitle = [...questionContext].reverse().find((line) => /[?？]/.test(line))
    ?? questionContext.at(-1);
  return {
    state: kind === 'approval' ? 'approval' : 'input',
    confidence: kind === 'question' ? 0.92 : kind === 'approval' ? 0.9 : 0.85,
    evidence: lines.slice(contextStart, footerIndex + 1).filter(Boolean),
    actions,
    interaction: {
      kind,
      title: questionTitle?.trim() || context[0]?.trim() || '请选择一个选项',
      context,
      interactionId,
      revision,
      semantics,
      contentConfidence: knownHeader >= 0 || hardBoundary >= 0 ? 0.95 : 0.65,
      actionConfidence: semantics ? semantics.confidence : 0.55,
    },
  };
}

function selectionMarker(value?: string): ScreenAction['marker'] {
  if (!value) return undefined;
  if (value === '[ ]' || value === '☐') return 'unchecked';
  if (/^\[[xX✓✔]\]$/.test(value) || value === '☑') return 'checked';
  if (value === '○') return 'unselected';
  if (value === '●') return 'selected';
  return undefined;
}

function matchesAny(value: string, patterns: readonly RegExp[]): boolean {
  return patterns.some((pattern) => pattern.test(value));
}

function withoutFocusMarker(value: string): string {
  return value.replace(/^\s*[›>❯]\s*/, '').trim();
}

function isSidePanelLine(value: string): boolean {
  return /[│┌┐└┘├┤┬┴┼╔╗╚╝╠╣╦╩╬║═]/.test(value);
}

function controlRole(label: string, dialect: TerminalDialect): ScreenAction['role'] {
  if (matchesAny(label, dialect.customInputControls)) return 'custom-input';
  if (matchesAny(label, dialect.chatControls)) return 'chat';
  return 'answer';
}

function selectionSemantics(actions: ScreenAction[], footer: string): import('./interaction-types.js').SelectionSemantics | undefined {
  const answers = actions.filter(({ role }) => role === 'answer');
  const submit = actions.find(({ role }) => role === 'submit');
  const hasCheckbox = answers.length > 0 && answers.every(({ marker }) => marker === 'checked' || marker === 'unchecked');
  const hasRadio = answers.length > 0 && answers.every(({ marker }) => marker === 'selected' || marker === 'unselected');
  if (hasCheckbox || hasRadio) {
    const commit = submit
      ? { mode: 'explicit' as const, controlId: submit.id }
      : /ctrl\+enter\s+to\s+(?:submit|confirm)/i.test(footer)
        ? { mode: 'key' as const, key: 'C-Enter' }
        : /enter\s+to\s+(?:submit|confirm)(?:\s+answer)?/i.test(footer)
          ? { mode: 'key' as const, key: 'Enter' }
        : undefined;
    if (!commit) return undefined;
    const toggleKey = /space\s+to\s+toggle/i.test(footer) ? 'Space' : 'Enter';
    return {
      cardinality: hasCheckbox ? 'many' : 'one', activation: 'toggle', toggleKey, commit,
      confidence: 0.97,
      evidence: [hasCheckbox ? 'answer controls use checkbox markers' : 'answer controls use radio markers', 'an explicit commit mechanism exists'],
    };
  }
  if (answers.some(({ marker }) => marker)) return undefined;
  return {
    cardinality: 'one', activation: 'submit', commit: { mode: 'immediate' }, confidence: 0.9,
    evidence: ['numbered controls use a single focus marker and no persistent selection markers'],
  };
}

function latestOptionGroup(starts: number[]): number[] {
  const group = [starts.at(-1) as number];
  for (let index = starts.length - 2; index >= 0; index -= 1) {
    const start = starts[index] as number;
    if ((group[0] as number) - start > 8) break;
    group.unshift(start);
  }
  return group;
}

function classifyChoice(context: string[], actions: ScreenAction[], footer: string): ChoiceInteractionKind {
  const contextText = context.join(' ');
  if (/(?:^|\s)[☐☑☒]\s+\S|Question\s+\d+\/\d+/i.test(contextText) || /submit answer|add notes/i.test(footer)) return 'question';
  const optionText = actions.map(({ label, description }) => `${label} ${description ?? ''}`).join(' ');
  if (/(?:Would you like to|Do you want to).*(?:run|edit|grant|access)|approval required|allow command|requires approval/i.test(contextText)
    || /full access|don't ask again|do not ask again|always allow|auto mode|permissions?\b/i.test(optionText)) return 'approval';
  return 'choice';
}

function choiceOptionStart(line: string): boolean {
  return Boolean(parseChoiceOptionLine(line));
}

function parseChoiceOptionLine(line: string): { focused: boolean; key: string; marker?: string; label: string } | undefined {
  const match = line.match(/^\s*([›>❯])?\s*(?:(\[[ xX✓✔]\]|[☐☑○●])\s*)?(\d+)[.)]\s+(?:(\[[ xX✓✔]\]|[☐☑○●])\s*)?(.+?)\s*$/);
  if (!match?.[3] || !match[5]) return undefined;
  return { focused: Boolean(match[1]), marker: match[2] ?? match[4], key: match[3], label: match[5] };
}

function choiceRisk(text: string): ChoiceRisk {
  if (/full access|bypass|without sandbox|dangerously/i.test(text)) return 'privileged';
  if (/always|don't ask again|do not ask again|auto mode|persist/i.test(text)) return 'persistent';
  if (/^\s*no\b|reject|deny|cancel|do differently/i.test(text)) return 'reject';
  return 'normal';
}

function result(
  state: ScreenState,
  confidence: number,
  normalized: string,
  fingerprint: string,
  evidence: string[],
): ScreenDetection {
  return { state, confidence, normalized, fingerprint, evidence, actions: [], hasDraftInput: false };
}

function matching(lines: string[], pattern: RegExp): string[] {
  return lines.filter((line) => pattern.test(line)).slice(-4);
}

function lastMatchingIndex(lines: string[], pattern: RegExp): number {
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (pattern.test(lines[index] ?? '')) return index;
  }
  return -1;
}
