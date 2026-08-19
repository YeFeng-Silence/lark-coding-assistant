import { randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir } from 'node:fs/promises';
import type { AppConfig, AppSecrets, SessionState } from './model.js';
import { emptyState } from './model.js';
import type { AppPaths } from './paths.js';
import { readJson, writeJsonAtomic } from './atomic-json.js';

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

  loadConfig(): Promise<AppConfig | undefined> {
    return readJson<AppConfig>(this.paths.config);
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
    return (await readJson<SessionState>(this.paths.state)) ?? emptyState();
  }

  saveState(state: SessionState): Promise<void> {
    return writeJsonAtomic(this.paths.state, state);
  }
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
