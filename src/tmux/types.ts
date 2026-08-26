export interface TmuxPane {
  sessionName: string;
  paneId: string;
  pid: number;
  startCommand: string;
  currentCommand: string;
  cwd: string;
  dead: boolean;
  exitStatus?: number;
  cursorX: number;
  cursorY: number;
}

export type TmuxInspectResult =
  | { status: 'live'; pane: TmuxPane }
  | { status: 'dead'; pane: TmuxPane }
  | { status: 'missing' }
  | { status: 'unavailable'; error: unknown };

export interface TmuxSessionMetadata {
  managed: true;
  sessionId: string;
  agent: 'codex' | 'traex' | 'claude';
  cwd: string;
  agentVersion: string;
  agentSessionId?: string;
}

export interface TmuxCreateOptions {
  sessionName: string;
  cwd: string;
  binary: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
  preserveOnExit?: boolean;
  signal?: AbortSignal;
}
