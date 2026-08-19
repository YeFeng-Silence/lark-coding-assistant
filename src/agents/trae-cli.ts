import { detectTraeScreen } from '../screen/detector.js';
import { resumeArgs } from './resume.js';
import { codexStyleStopHookArgs } from './stop-hook.js';
import type { AgentAdapter } from './types.js';

export const traeCliAdapter: AgentAdapter = {
  id: 'trae-cli',
  displayName: 'Trae CLI',
  groupOrder: 20,
  binary: (config) => config.agentBinaries['trae-cli'],
  versionArgs: ['--version'],
  buildLaunchArgs: ({ resume, stopHookCommand }) => [
    ...codexStyleStopHookArgs(stopHookCommand),
    ...resumeArgs(resume),
  ],
  detectScreen: detectTraeScreen,
};
