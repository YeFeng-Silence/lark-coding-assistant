const ANSI = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/g;
const FORBIDDEN_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;

export function sanitizeRemoteInput(input: string): string {
  return input.replace(ANSI, '').replace(/\r\n?/g, '\n').replace(FORBIDDEN_CONTROL, '');
}

export function assertSafeTmuxTarget(target: string): void {
  if (!/^%\d+$/.test(target)) throw new Error(`unsafe tmux pane target: ${target}`);
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
