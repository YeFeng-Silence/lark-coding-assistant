import type { AgentId } from '../agents/types.js';
import type { WorkspaceCandidate } from './discovery.js';

export interface SessionCreateDraft {
  sessionId?: string;
  agent: AgentId;
  resumeMode: 'new' | 'picker';
  cwd?: string;
  projectCwd?: string;
  manualCwd?: string;
}

export interface SessionCreateView {
  mode: 'projects' | 'manual';
  snapshotId?: string;
  page: number;
  pageCount: number;
  candidates: WorkspaceCandidate[];
  hasProjectCandidates?: boolean;
  partial: boolean;
  warnings: string[];
  draft: SessionCreateDraft;
}

export function emptySessionCreateDraft(): SessionCreateDraft {
  return { agent: 'codex', resumeMode: 'new' };
}
