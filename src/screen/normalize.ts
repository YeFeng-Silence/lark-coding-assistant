// CSI, OSC and two-byte escape sequences commonly emitted by terminal UIs.
const ANSI = /\u001b(?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~]|[@-_])/g;

export function stripAnsi(raw: string): string {
  return raw.replace(ANSI, '');
}

export function normalizeScreen(raw: string): string {
  return stripAnsi(raw)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\u00a0|\u3000/g, ' ').replace(/\t/g, '  ').replace(/ +$/g, ''))
    .filter((line, index, all) => line !== '' || all[index - 1] !== '')
    .join('\n')
    .trim();
}

export function tailScreen(raw: string, lines = 60): string {
  return normalizeScreen(raw).split('\n').slice(-lines).join('\n');
}
