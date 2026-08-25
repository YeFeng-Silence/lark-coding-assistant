import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, normalize, resolve } from 'node:path';
import { AppError, systemErrorCode } from '../core/errors.js';

export function normalizeWorkspacePath(input: string, home = homedir()): string {
  const value = input.trim();
  if (!value) throw invalidCwd(input, '工作目录不能为空');
  let expanded = value;
  if (value === '~') expanded = home;
  else if (value.startsWith('~/')) expanded = resolve(home, value.slice(2));
  else if (value.startsWith('~')) throw invalidCwd(input, '不支持 ~other-user，请使用 ~ 或 ~/目录');
  if (!isAbsolute(expanded)) throw invalidCwd(input, '工作目录必须是绝对路径，或使用 ~/目录');
  return normalize(expanded);
}

export async function validateWorkspaceDirectory(input: string, home = homedir()): Promise<string> {
  const cwd = normalizeWorkspacePath(input, home);
  let info;
  try {
    info = await stat(cwd);
  } catch (error) {
    const reason = systemErrorCode(error) === 'EACCES'
      ? `无权访问工作目录：${cwd}`
      : `工作目录不存在或不可用：${cwd}`;
    throw invalidCwd(cwd, reason, error);
  }
  if (!info.isDirectory()) throw invalidCwd(cwd, `工作目录不是文件夹：${cwd}`);
  try {
    await access(cwd, constants.R_OK | constants.X_OK);
  } catch (error) {
    throw invalidCwd(cwd, `无权进入工作目录：${cwd}`, error);
  }
  return cwd;
}

export function normalizeWorkspaceRoots(values: readonly string[], home = homedir()): string[] {
  const unique = new Set<string>();
  for (const value of values) unique.add(normalizeWorkspacePath(value, home));
  return [...unique];
}

function invalidCwd(cwd: string, reason: string, cause?: unknown): AppError {
  return new AppError('INVALID_CWD', reason, { cwd, reason }, cause === undefined ? {} : { cause });
}
