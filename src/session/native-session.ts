import { readdir, readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentId } from '../agents/types.js';
import { runFile } from '../platform/process.js';

const UUID = '[0-9a-fA-F-]{32,36}';

export async function resolveNativeAgentSessionId(
  agent: AgentId,
  pid: number,
  home = homedir(),
  signal?: AbortSignal,
): Promise<string | undefined> {
  if (!Number.isInteger(pid) || pid <= 0) return undefined;
  if (agent === 'traex') {
    const peer = await resolveTraexPeer(pid, home);
    if (peer) return peer;
    return matchPath(
      await processOpenFiles(pid, signal),
      new RegExp(`/\\.trae/cli/sessions/.+/rollout-[^/]+-(${UUID})\\.jsonl(?:\\.lock)?$`),
    );
  }
  const openFiles = await processOpenFiles(pid, signal);
  if (agent === 'codex') return matchPath(openFiles, new RegExp(`/\\.codex/thread-writer-locks/(${UUID})\\.lock$`));
  return matchPath(openFiles, new RegExp(`/\\.claude/projects/[^/]+/(${UUID})\\.jsonl$`));
}

async function resolveTraexPeer(pid: number, home: string): Promise<string | undefined> {
  const directory = join(home, '.trae', 'cli', 'session-peers');
  const entries = await readdir(directory).catch(() => [] as string[]);
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const value = await readFile(join(directory, entry), 'utf8').then(JSON.parse).catch(() => undefined) as unknown;
    if (!value || typeof value !== 'object') continue;
    const peer = value as Record<string, unknown>;
    if (peer.pid === pid && typeof peer.threadId === 'string' && peer.threadId) return peer.threadId;
  }
  return undefined;
}

async function processOpenFiles(pid: number, signal?: AbortSignal): Promise<string[]> {
  const result = await runFile('lsof', ['-Fn', '-p', String(pid)], { timeoutMs: 3_000, signal }).catch(() => undefined);
  if (!result) return [];
  return result.stdout.split('\n').filter((line) => line.startsWith('n')).map((line) => line.slice(1));
}

function matchPath(paths: string[], pattern: RegExp): string | undefined {
  for (const path of paths) {
    const match = path.match(pattern);
    if (match?.[1]) return match[1];
  }
  return undefined;
}
