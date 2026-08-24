import { detectTraeScreen } from '../screen/detector.js';
import { resumeArgs } from './resume.js';
import { codexStyleStopHookArgs } from './stop-hook.js';
import type { AgentAdapter } from './types.js';

export const traeCliAdapter: AgentAdapter = {
  id: 'traex',
  displayName: 'traex',
  groupOrder: 20,
  binary: (config) => config.agentBinaries.traex,
  versionArgs: ['--version'],
  buildLaunchArgs: ({ resume, stopHookCommand }) => [
    ...codexStyleStopHookArgs(stopHookCommand),
    ...resumeArgs(resume),
  ],
  detectScreen: detectTraeScreen,
};
