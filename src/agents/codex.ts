import { detectCodexScreen } from '../screen/detector.js';
import { resumeArgs } from './resume.js';
import { codexStyleStopHookArgs } from './stop-hook.js';
import type { AgentAdapter } from './types.js';

export const codexAdapter: AgentAdapter = {
  id: 'codex',
  displayName: 'Codex',
  groupOrder: 10,
  binary: (config) => config.agentBinaries.codex,
  versionArgs: ['--version'],
  buildLaunchArgs: ({ resume, stopHookCommand }) => [
    ...codexStyleStopHookArgs(stopHookCommand),
    ...resumeArgs(resume),
  ],
  detectScreen: detectCodexScreen,
};
