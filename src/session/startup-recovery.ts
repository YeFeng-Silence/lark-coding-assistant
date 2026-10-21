import type { ManagedSession, StartupRecovery, SessionState } from '../core/model.js';
import type { ScreenDetection } from '../screen/detector.js';

export function startupProgress(session: ManagedSession): string {
  return session.startupRecovery?.resume ? '尚未完成 Resume' : '尚未完成会话创建';
}

export function newSessionPromptReady(screen: ScreenDetection): boolean {
  return screen.state === 'idle' && screen.confidence >= 0.8
    && !screen.hasDraftInput && !screen.interaction;
}

// Both the connection revision and pane identity matter: returning to a session
// with a reused name, or undoing an explicit user switch, would be surprising.
export function startupRollbackTarget(
  state: SessionState,
  removed: ManagedSession,
  sessions: Record<string, ManagedSession>,
): string | undefined {
  const recovery = removed.startupRecovery;
  if (!recovery || state.activeSessionId !== removed.id
    || recovery.activationRevision === undefined
    || recovery.activationRevision !== (state.connectionRevision ?? 0)) return undefined;
  const previous = recovery.previousSessionId ? sessions[recovery.previousSessionId] : undefined;
  return previous && previous.paneId === recovery.previousPaneId ? previous.id : undefined;
}

export function parseStartupRecovery(raw: string | undefined): StartupRecovery | undefined {
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as StartupRecovery;
    if (!value || !['picker', 'manual', 'identity'].includes(value.phase)) return undefined;
    if (value.resume !== undefined && (!value.resume || !['picker', 'last', 'session'].includes(value.resume.mode))) return undefined;
    if (value.phase === 'picker' && value.resume?.mode !== 'picker') return undefined;
    if (value.resume?.mode === 'session' && typeof value.resume.sessionId !== 'string') return undefined;
    if (value.previousSessionId !== undefined && typeof value.previousSessionId !== 'string') return undefined;
    if (value.previousPaneId !== undefined && typeof value.previousPaneId !== 'string') return undefined;
    if (value.activationRevision !== undefined && !Number.isSafeInteger(value.activationRevision)) return undefined;
    return value;
  } catch { return undefined; }
}
