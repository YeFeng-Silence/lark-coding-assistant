const MAX_LINES = 20;
const MAX_CHARS = 2_000;
const EMPTY_EXCERPT = 'Agent 未输出可用错误信息。';

export function startupTerminalExcerpt(raw: string): string {
  const sanitized = redactSecrets(stripTerminalControls(raw));
  const lines = sanitized
    .split('\n')
    .map(cleanLine)
    .filter((line) => line !== undefined) as string[];
  while (lines[0] === '') lines.shift();
  while (lines.at(-1) === '') lines.pop();
  if (lines.length === 0) return EMPTY_EXCERPT;

  const errorIndex = lines.findIndex((line) => /\b(?:error|failed|fatal)\b/i.test(line));
  const selected = (errorIndex >= 0 ? lines.slice(errorIndex) : lines.slice(-MAX_LINES)).slice(0, MAX_LINES);
  let excerpt = selected.join('\n').trim();
  if (!excerpt) return EMPTY_EXCERPT;

  const lineTruncated = errorIndex >= 0
    ? lines.length - errorIndex > MAX_LINES
    : lines.length > MAX_LINES;
  const charTruncated = excerpt.length > MAX_CHARS;
  if (charTruncated) excerpt = excerpt.slice(0, MAX_CHARS).trimEnd();
  if (lineTruncated || charTruncated) excerpt = `${excerpt}\n… 输出已截断`;
  return excerpt;
}

function stripTerminalControls(value: string): string {
  return value
    // CSI and OSC escape sequences emitted by interactive TUIs.
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/g, '')
    .replace(/\u001B(?:[@-_][0-?]*[ -/]*[@-~]|\[[0-?]*[ -/]*[@-~])/g, '')
    .replace(/\r/g, '\n')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001A\u001C-\u001F\u007F]/g, '');
}

function cleanLine(value: string): string | undefined {
  const line = value.replace(/[ \t]+$/g, '').trimStart();
  if (/^Pane is dead(?:\s|\(|$)/i.test(line)) return undefined;
  if (/^[╭╮╰╯┌┐└┘─━═│┃┊┋┄┅┈┉┼├┤┬┴┿╋+\-_=\s]+$/.test(line)) return undefined;
  return line.replace(/^[│┃]\s?/, '').replace(/\s?[│┃]$/, '').trimEnd();
}

function redactSecrets(value: string): string {
  return value
    .replace(/\b(authorization\s*[:=]\s*)(?:Bearer\s+)?[^\s,;]+/gi, '$1[REDACTED]')
    .replace(/\b(Bearer)\s+[^\s,'"\]}]+/gi, '$1 [REDACTED]')
    .replace(
      /\b(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|app[_-]?secret|cookie)\b(\s*[:=]\s*)([^\s,;]+)/gi,
      '$1$2[REDACTED]',
    )
    .replace(/([?&](?:api[_-]?key|access[_-]?token|token|secret|signature)=)[^&#\s]+/gi, '$1[REDACTED]');
}
