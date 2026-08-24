import { appendFile } from 'node:fs/promises';
import { normalizeSessionStartEvent, normalizeStopEvent } from './agents/stop-event.js';
import { normalizeAgentId } from './agents/types.js';
import { requestDaemon } from './daemon/client.js';
import { resolveAppPaths } from './core/paths.js';

const socket = process.env.LARK_CODING_ASSISTANT_SOCKET;
const sessionId = process.env.LARK_CODING_ASSISTANT_SESSION_ID;
const agent = normalizeAgentId(process.env.LARK_CODING_ASSISTANT_AGENT ?? '');

try {
  if (!socket || !sessionId) throw new Error('missing bridge hook environment');
  const payload = JSON.parse(await readStdin()) as unknown;
  const started = agent ? normalizeSessionStartEvent(sessionId, agent, payload) : undefined;
  const completed = normalizeStopEvent(sessionId, payload);
  if (!started && !completed) throw new Error('invalid lifecycle hook payload');
  const result = await requestDaemon(socket, started
    ? { method: 'agentSessionStarted', candidate: started }
    : { method: 'turnComplete', candidate: completed as NonNullable<typeof completed> }, 3_000);
  if (!result.ok) throw new Error(result.error);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  const paths = resolveAppPaths();
  await appendFile(paths.logFile, `${new Date().toISOString()} Stop hook delivery failed: ${message}\n`, { mode: 0o600 })
    .catch(() => undefined);
}

async function readStdin(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let value = '';
  for await (const chunk of process.stdin) value += chunk;
  return value;
}
