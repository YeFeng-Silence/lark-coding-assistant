export interface TmuxPane {
  sessionName: string;
  paneId: string;
  pid: number;
  currentCommand: string;
  cwd: string;
  dead: boolean;
  cursorX: number;
  cursorY: number;
}

export interface TmuxCreateOptions {
  sessionName: string;
  cwd: string;
  binary: string;
  args?: readonly string[];
  env?: Readonly<Record<string, string>>;
}
