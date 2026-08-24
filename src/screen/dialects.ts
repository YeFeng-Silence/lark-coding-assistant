import type { TerminalDialect } from './interaction-types.js';

const commonHeaders = [
  /^\s*(?:Would you like to|Do you want to|Approval required|Allow command|.*requires approval)/i,
];
const commonFooters = [
  /(?:press\s+)?enter\s+to\s+(?:confirm|submit(?:\s+answer)?|select|choose|continue)/i,
  /esc\s+to\s+cancel.*(?:tab\s+to\s+amend|ctrl\+e\s+to\s+explain)/i,
];

export const CODEX_DIALECT: TerminalDialect = {
  id: 'codex',
  headerPatterns: [...commonHeaders, /^\s*Question\s+\d+\/\d+/i],
  footerPatterns: commonFooters,
  submitControls: [/^(?:submit|confirm)$/i],
  customInputControls: [/^(?:type something|none of the above|add notes)$/i],
  chatControls: [/^chat about this$/i],
};

export const TRAE_DIALECT: TerminalDialect = {
  ...CODEX_DIALECT,
  id: 'traex',
  headerPatterns: [...commonHeaders, /^\s*Question\s+\d+\/\d+/i],
  customInputControls: [/^(?:other|none of the above|add notes)$/i],
};

export const CLAUDE_DIALECT: TerminalDialect = {
  id: 'claude',
  headerPatterns: [
    ...commonHeaders,
    /^\s*(?:←\s*)?[☐☑☒]\s+.+?(?:\s+✔\s+Submit\s*→)?\s*$/i,
    /^\s*[☐☑☒]\s+\S/,
  ],
  footerPatterns: commonFooters,
  footerlessChoiceHeaders: [/^ready to submit your answers\?$/i],
  submitControls: [/^(?:submit|confirm)$/i],
  customInputControls: [/^(?:type(?:\s+.+)?|add notes)\.?$/i, /^notes:\s*press\s+n\s+to\s+add\b/i],
  directInputControls: [/^type(?:\s+.+)?\.?$/i],
  customInputValuePattern: /^type\s+(.+?)\.?$/i,
  chatControls: [/^chat about this$/i],
};
