import type { AgentId } from '../agents/types.js';
import type { ManagedSession, SessionState } from '../core/model.js';
import type { TmuxInspectResult, TmuxPane, TmuxSessionMetadata } from '../tmux/types.js';
import { validSessionId } from './start-request.js';

export interface SessionTmux {
  inspectStatus(paneId: string, signal?: AbortSignal): Promise<TmuxInspectResult>;
  inspectSession(sessionName: string, signal?: AbortSignal): Promise<TmuxInspectResult>;
  listSessions(prefix: string, signal?: AbortSignal): Promise<TmuxPane[]>;
  readMetadata(sessionName: string, signal?: AbortSignal): Promise<TmuxSessionMetadata | undefined>;
  writeMetadata(sessionName: string, metadata: TmuxSessionMetadata, signal?: AbortSignal): Promise<void>;
  killSession(sessionName: string, signal?: AbortSignal): Promise<void>;
}

export interface ReconcileResult {
  state: SessionState;
  liveSessions: ManagedSession[];
  removedActive?: ManagedSession;
  changed: boolean;
}

export class SessionReconciler {
  private readonly misses = new Map<string, number>();

  constructor(
    private readonly tmux: SessionTmux,
    private readonly sessionPrefix = 'lark-coding-assistant',
    private readonly missingThreshold = 3,
    private readonly log: (message: string) => Promise<void> = async () => undefined,
    private readonly resolveAgentVersion: (agent: AgentId, signal?: AbortSignal) => Promise<string> = async () => 'unknown',
  ) {}

  async reconcile(input: SessionState, discover = false, signal?: AbortSignal): Promise<ReconcileResult> {
    const sessions = { ...input.sessions };
    let changed = false;
    for (const [id, session] of Object.entries(sessions)) {
      if (signal?.aborted) throw signal.reason;
      const result = await this.confirm(session, signal);
      if (result.status === 'unavailable') {
        await this.log(`tmux inspection unavailable for ${id}: ${errorMessage(result.error)}`);
        continue;
      }
      if (result.status === 'live') {
        this.misses.delete(id);
        if (result.pane.paneId !== session.paneId || result.pane.sessionName !== session.sessionName) {
          sessions[id] = { ...session, paneId: result.pane.paneId, sessionName: result.pane.sessionName, updatedAt: Date.now() };
          changed = true;
        }
        continue;
      }
      if (result.status === 'dead') {
        await this.tmux.killSession(result.pane.sessionName, signal).catch((error) => this.log(
          `failed to clean dead tmux session ${result.pane.sessionName}: ${errorMessage(error)}`,
        ));
        delete sessions[id];
        this.misses.delete(id);
        changed = true;
        continue;
      }
      const misses = (this.misses.get(id) ?? 0) + 1;
      this.misses.set(id, misses);
      if (misses < this.missingThreshold) continue;
      delete sessions[id];
      this.misses.delete(id);
      changed = true;
    }

    if (discover) {
      changed = await this.discover(sessions, signal) || changed;
    }

    const activeSessionId = input.activeSessionId && sessions[input.activeSessionId]
      ? input.activeSessionId
      : Object.keys(sessions)[0];
    if (activeSessionId !== input.activeSessionId) changed = true;
    const removedActive = input.activeSessionId && !sessions[input.activeSessionId]
      ? input.sessions?.[input.activeSessionId]
      : undefined;
    const state = changed
      ? { ...input, sessions, activeSessionId, updatedAt: Date.now() }
      : input;
    return { state, liveSessions: Object.values(sessions), removedActive, changed };
  }

  private async confirm(session: ManagedSession, signal?: AbortSignal): Promise<TmuxInspectResult> {
    const direct = await this.tmux.inspectStatus(session.paneId, signal);
    if (direct.status === 'live' || direct.status === 'unavailable') return direct;
    const byName = await this.tmux.inspectSession(session.sessionName, signal);
    if (byName.status === 'live' || byName.status === 'unavailable') return byName;
    return byName.status === 'dead' ? byName : direct;
  }

  private async discover(sessions: Record<string, ManagedSession>, signal?: AbortSignal): Promise<boolean> {
    let panes: TmuxPane[];
    try {
      panes = await this.tmux.listSessions(`${this.sessionPrefix}-`, signal);
    } catch (error) {
      await this.log(`tmux session discovery unavailable: ${errorMessage(error)}`);
      return false;
    }
    let changed = false;
    const seen = new Set<string>();
    const liveSessionNames = new Set(panes.filter((pane) => !pane.dead).map((pane) => pane.sessionName));
    for (const pane of panes) {
      if (signal?.aborted) throw signal.reason;
      if (seen.has(pane.sessionName)) continue;
      seen.add(pane.sessionName);
      if (pane.dead) {
        if (!liveSessionNames.has(pane.sessionName)) {
          await this.tmux.killSession(pane.sessionName, signal).catch((error) => this.log(
            `failed to clean orphaned dead tmux session ${pane.sessionName}: ${errorMessage(error)}`,
          ));
        }
        continue;
      }
      const registered = Object.values(sessions).find((session) => session.sessionName === pane.sessionName);
      if (registered) {
        if (registered.paneId !== pane.paneId) {
          sessions[registered.id] = { ...registered, paneId: pane.paneId, updatedAt: Date.now() };
          changed = true;
        }
        if (!await this.tmux.readMetadata(pane.sessionName, signal)) {
          await this.writeMetadata(pane, registered, signal).catch((error) => this.log(
            `failed to backfill tmux metadata for ${registered.id}: ${errorMessage(error)}`,
          ));
        }
        continue;
      }

      const metadata = await this.tmux.readMetadata(pane.sessionName, signal);
      const recovered = metadata
        ? this.fromMetadata(pane, metadata)
        : await this.fromLegacy(pane, signal);
      if (!recovered || sessions[recovered.id]) continue;
      if (!metadata) {
        try {
          await this.writeMetadata(pane, recovered, signal);
        } catch (error) {
          await this.log(`failed to persist recovered tmux metadata for ${recovered.id}: ${errorMessage(error)}`);
          continue;
        }
      }
      sessions[recovered.id] = recovered;
      this.misses.delete(recovered.id);
      changed = true;
      await this.log(`recovered managed session ${recovered.id} from tmux`);
    }
    return changed;
  }

  private fromMetadata(pane: TmuxPane, metadata: TmuxSessionMetadata): ManagedSession | undefined {
    if (!validSessionId(metadata.sessionId)
      || pane.sessionName !== `${this.sessionPrefix}-${metadata.sessionId}`) return undefined;
    return {
      id: metadata.sessionId,
      agent: metadata.agent,
      sessionName: pane.sessionName,
      paneId: pane.paneId,
      cwd: metadata.cwd,
      agentVersion: metadata.agentVersion,
      agentSessionId: metadata.agentSessionId,
      updatedAt: Date.now(),
    };
  }

  private async fromLegacy(pane: TmuxPane, signal?: AbortSignal): Promise<ManagedSession | undefined> {
    const id = pane.sessionName.startsWith(`${this.sessionPrefix}-`)
      ? pane.sessionName.slice(this.sessionPrefix.length + 1)
      : '';
    const agent = inferLegacyAgent(pane);
    if (!validSessionId(id) || !agent) return undefined;
    const agentVersion = await this.resolveAgentVersion(agent, signal).catch(() => 'unknown');
    return {
      id,
      agent,
      sessionName: pane.sessionName,
      paneId: pane.paneId,
      cwd: pane.cwd,
      agentVersion,
      updatedAt: Date.now(),
    };
  }

  private writeMetadata(pane: TmuxPane, session: ManagedSession, signal?: AbortSignal): Promise<void> {
    return this.tmux.writeMetadata(pane.sessionName, {
      managed: true,
      sessionId: session.id,
      agent: session.agent,
      cwd: session.cwd,
      agentVersion: session.agentVersion,
      agentSessionId: session.agentSessionId,
    }, signal);
  }
}

export function inferLegacyAgent(pane: Pick<TmuxPane, 'startCommand' | 'currentCommand'>): AgentId | undefined {
  const command = `${pane.startCommand}\n${pane.currentCommand}`;
  if (/(?:^|[\s/'"])(?:trae-cli|traex)(?:[\s/'"]|$)/i.test(command)) return 'traex';
  if (/(?:^|[\s/'"])claude(?:[\s/'"]|$)/i.test(command)) return 'claude';
  if (/(?:^|[\s/'"])codex(?:[\s/'"]|$)/i.test(command)) return 'codex';
  return undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
