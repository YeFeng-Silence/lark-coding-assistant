import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import type { AppConfig, AppSecrets, SessionState } from './model.js';
import { emptyState } from './model.js';
import type { AppPaths } from './paths.js';
import { readJson, writeJsonAtomic } from './atomic-json.js';
import { normalizeAgentId } from '../agents/types.js';

export class AppStore {
  constructor(readonly paths: AppPaths) {}

  async ensure(): Promise<void> {
    await mkdir(this.paths.root, { recursive: true, mode: 0o700 });
    await mkdir(this.paths.runtimeDir, { recursive: true, mode: 0o700 });
    await mkdir(this.paths.logsDir, { recursive: true, mode: 0o700 });
    await Promise.all([
      chmod(this.paths.root, 0o700),
      chmod(this.paths.runtimeDir, 0o700),
      chmod(this.paths.logsDir, 0o700),
    ]);
  }

  async loadConfig(): Promise<AppConfig | undefined> {
    const config = await readJson<LegacyConfig>(this.paths.config);
    if (!config) return undefined;
    const binaries = config.agentBinaries ?? {};
    return {
      tenant: config.tenant,
      appId: config.appId,
      tmuxBinary: config.tmuxBinary,
      agentBinaries: {
        codex: binaries.codex ?? 'codex',
        traex: binaries.traex ?? binaries['trae-cli'] ?? 'trae-cli',
        claude: binaries.claude ?? binaries['claude-code'] ?? 'claude',
      },
      pollIntervalMs: config.pollIntervalMs,
    };
  }

  saveConfig(config: AppConfig): Promise<void> {
    return writeJsonAtomic(this.paths.config, config);
  }

  loadSecrets(): Promise<AppSecrets | undefined> {
    return readJson(this.paths.secrets);
  }

  saveSecrets(secrets: AppSecrets): Promise<void> {
    return writeJsonAtomic(this.paths.secrets, secrets);
  }

  async loadState(): Promise<SessionState> {
    const state = await readJson<LegacyState>(this.paths.state);
    if (!state) return emptyState();
    const sessions = Object.fromEntries(Object.entries(state.sessions ?? {}).flatMap(([id, session]) => {
      const agent = normalizeAgentId(session.agent);
      return agent ? [[id, { ...session, agent }]] : [];
    }));
    return { ...state, sessions };
  }

  saveState(state: SessionState): Promise<void> {
    return writeJsonAtomic(this.paths.state, state);
  }
}

interface LegacyConfig extends Omit<AppConfig, 'agentBinaries'> {
  agentBinaries: Partial<Record<'codex' | 'traex' | 'claude' | 'trae-cli' | 'claude-code', string>>;
}

interface LegacyState extends Omit<SessionState, 'sessions'> {
  sessions?: Record<string, Omit<NonNullable<SessionState['sessions']>[string], 'agent'> & { agent: string }>;
}

export function createBindCode(): string {
  return randomBytes(16).toString('base64url');
}

export function hashBindCode(code: string): string {
  const salt = randomBytes(16);
  const digest = scryptSync(code, salt, 32);
  return `${salt.toString('base64url')}.${digest.toString('base64url')}`;
}

export function verifyBindCode(code: string, encoded: string): boolean {
  const [saltText, digestText] = encoded.split('.');
  if (!saltText || !digestText) return false;
  const expected = Buffer.from(digestText, 'base64url');
  const actual = scryptSync(code, Buffer.from(saltText, 'base64url'), expected.length);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
