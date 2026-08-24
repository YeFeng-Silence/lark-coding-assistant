import type { AgentResume, ResumeOptions } from './types.js';
import { AppError } from '../core/errors.js';

export function resolveResumeOption(options: ResumeOptions): AgentResume | undefined {
  const modes = [options.resume !== undefined, options.resumeLast, options.resumeAll].filter(Boolean).length;
  if (modes > 1) {
    throw new AppError(
      'INVALID_RESUME',
      '--resume, --resume-last, and --resume-all cannot be used together',
      { reason: '--resume、--resume-last 和 --resume-all 不能同时使用' },
    );
  }
  if (options.resumeLast) return { mode: 'last' };
  if (options.resumeAll) return { mode: 'picker', all: true };
  if (typeof options.resume === 'string') return { mode: 'session', sessionId: options.resume };
  if (options.resume) return { mode: 'picker' };
  return undefined;
}

export function resumeArgs(resume?: AgentResume): string[] {
  if (!resume) return [];
  if (resume.mode === 'last') return ['resume', '--last'];
  if (resume.mode === 'session') return ['resume', resume.sessionId];
  return resume.all ? ['resume', '--all'] : ['resume'];
}

export function claudeResumeArgs(resume?: AgentResume): string[] {
  if (!resume) return [];
  if (resume.mode === 'last') return ['--continue'];
  if (resume.mode === 'session') return ['--resume', resume.sessionId];
  return ['--resume'];
}
