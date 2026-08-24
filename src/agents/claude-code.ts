import { detectClaudeScreen } from '../screen/detector.js';
import { claudeResumeArgs } from './resume.js';
import { claudeStopHookArgs } from './stop-hook.js';
import type { AgentAdapter } from './types.js';

export const claudeCodeAdapter: AgentAdapter = {
  id: 'claude',
  displayName: 'claude',
  groupOrder: 30,
  binary: (config) => config.agentBinaries.claude,
  versionArgs: ['--version'],
  buildLaunchArgs: ({ resume, stopHookCommand }) => [
    ...claudeStopHookArgs(stopHookCommand),
    ...claudeResumeArgs(resume),
  ],
  detectScreen: detectClaudeScreen,
};
