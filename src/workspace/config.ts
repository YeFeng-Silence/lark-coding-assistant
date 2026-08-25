import { isAbsolute, resolve } from 'node:path';
import type { AppConfig } from '../core/model.js';
import { normalizeWorkspacePath, validateWorkspaceDirectory } from './path.js';

export async function addWorkspaceRoot(
  config: AppConfig,
  input: string,
  cwd = process.cwd(),
): Promise<{ config: AppConfig; path: string; added: boolean }> {
  const path = await validateWorkspaceDirectory(resolveWorkspaceRootInput(input, cwd));
  const existing = new Set(config.workspaceRoots);
  if (existing.has(path)) return { config, path, added: false };
  return { config: { ...config, workspaceRoots: [...config.workspaceRoots, path] }, path, added: true };
}

export function removeWorkspaceRoot(
  config: AppConfig,
  input: string,
  cwd = process.cwd(),
): { config: AppConfig; path: string; removed: boolean } {
  const path = normalizeWorkspacePath(resolveWorkspaceRootInput(input, cwd));
  const workspaceRoots = config.workspaceRoots.filter((candidate) => candidate !== path);
  return {
    config: workspaceRoots.length === config.workspaceRoots.length ? config : { ...config, workspaceRoots },
    path,
    removed: workspaceRoots.length !== config.workspaceRoots.length,
  };
}

export function listWorkspaceRoots(config: AppConfig): string[] {
  return [...config.workspaceRoots];
}

function resolveWorkspaceRootInput(input: string, cwd: string): string {
  const value = input.trim();
  return value && !value.startsWith('~') && !isAbsolute(value)
    ? resolve(cwd, value)
    : value;
}
