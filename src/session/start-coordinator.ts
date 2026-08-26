import { randomUUID } from 'node:crypto';
import type { AgentId, AgentResume } from '../agents/types.js';
import { AppError, asAppError } from '../core/errors.js';

export type SessionStartSource = 'cli' | 'lark' | 'resume-picker';

export interface SessionStartDescriptor {
  sessionId: string;
  agent: AgentId;
  cwd: string;
  resume?: AgentResume;
  source: SessionStartSource;
}

export interface SessionStartContext extends SessionStartDescriptor {
  startId: string;
  startedAt: number;
  deadline: number;
  signal: AbortSignal;
  remainingMs(): number;
  stage<T>(name: string, operation: () => Promise<T>): Promise<T>;
}

export type SessionStartOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; error: AppError };

export class SessionStartCoordinator {
  private readonly active = new Map<string, { startId: string; startedAt: number }>();

  constructor(
    private readonly timeoutMs = 30_000,
    private readonly log: (message: string) => Promise<void> = async () => undefined,
  ) {}

  async run<T>(
    descriptor: SessionStartDescriptor,
    execute: (context: SessionStartContext) => Promise<T>,
    cleanup: (context: SessionStartContext, error: AppError) => Promise<void>,
  ): Promise<SessionStartOutcome<T>> {
    const existing = this.active.get(descriptor.sessionId);
    if (existing) {
      return {
        ok: false,
        error: new AppError('SESSION_STARTING', `session is already starting: ${descriptor.sessionId}`, {
          sessionId: descriptor.sessionId,
          agent: descriptor.agent,
          cwd: descriptor.cwd,
          startId: existing.startId,
          elapsedMs: Date.now() - existing.startedAt,
        }),
      };
    }

    const startId = randomUUID();
    const startedAt = Date.now();
    const deadline = startedAt + this.timeoutMs;
    const controller = new AbortController();
    let currentStage = 'initializing';
    const fields = logFields({ ...descriptor, startId });
    const context: SessionStartContext = {
      ...descriptor,
      startId,
      startedAt,
      deadline,
      signal: controller.signal,
      remainingMs: () => Math.max(1, deadline - Date.now()),
      stage: async <Value>(name: string, operation: () => Promise<Value>): Promise<Value> => {
        if (controller.signal.aborted || Date.now() >= deadline) {
          throw timeoutError(descriptor, startId, name, startedAt, this.timeoutMs);
        }
        currentStage = name;
        const stageStartedAt = Date.now();
        await this.record(`session start stage requested: ${fields} stage=${name}`);
        try {
          const value = await operation();
          await this.record(`session start stage succeeded: ${fields} stage=${name} elapsedMs=${Date.now() - stageStartedAt}`);
          return value;
        } catch (error) {
          const normalized = controller.signal.aborted || Date.now() >= deadline
            ? timeoutError(descriptor, startId, name, startedAt, this.timeoutMs)
            : asAppError(error, 'START_FAILED', startErrorContext(descriptor, startId, name, startedAt));
          await this.record(`session start stage failed: ${fields} stage=${name} code=${normalized.code} elapsedMs=${Date.now() - stageStartedAt}`);
          throw normalized;
        } finally {
          if (currentStage === name) currentStage = 'finalizing';
        }
      },
    };
    this.active.set(descriptor.sessionId, { startId, startedAt });
    await this.record(`session start requested: ${fields}`);

    let timer: NodeJS.Timeout | undefined;
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        const error = timeoutError(descriptor, startId, currentStage, startedAt, this.timeoutMs);
        controller.abort(error);
        reject(error);
      }, this.timeoutMs);
    });
    const operation = execute(context);
    try {
      const value = await Promise.race([operation, timeout]);
      await this.record(`session start succeeded: ${fields} elapsedMs=${Date.now() - startedAt}`);
      return { ok: true, value };
    } catch (error) {
      const normalized = controller.signal.aborted || Date.now() >= deadline
        ? timeoutError(descriptor, startId, errorStage(error), startedAt, this.timeoutMs)
        : asAppError(error, 'START_FAILED', startErrorContext(descriptor, startId, errorStage(error), startedAt));
      if (!controller.signal.aborted) controller.abort(normalized);
      await operation.catch(() => undefined);
      await cleanup(context, normalized).catch(async (cleanupError) => {
        await this.record(`session start cleanup failed: ${fields} code=${normalized.code} detail=${message(cleanupError)}`);
      });
      await this.record(`${normalized.code === 'SESSION_START_TIMEOUT' ? 'session start timed out' : 'session start failed'}: ${fields} code=${normalized.code} stage=${String(normalized.context.stage ?? 'unknown')} elapsedMs=${Date.now() - startedAt}`);
      return { ok: false, error: normalized };
    } finally {
      if (timer) clearTimeout(timer);
      this.active.delete(descriptor.sessionId);
    }
  }

  private async record(message: string): Promise<void> {
    await this.log(message).catch(() => undefined);
  }
}

function timeoutError(
  descriptor: SessionStartDescriptor,
  startId: string,
  stage: string,
  startedAt: number,
  timeoutMs: number,
): AppError {
  return new AppError('SESSION_START_TIMEOUT', `session start exceeded ${timeoutMs} ms: ${descriptor.sessionId}`, {
    ...startErrorContext(descriptor, startId, stage, startedAt),
    timeoutMs,
  });
}

function startErrorContext(
  descriptor: SessionStartDescriptor,
  startId: string,
  stage: string,
  startedAt: number,
): Record<string, string | number | undefined> {
  return {
    sessionId: descriptor.sessionId,
    agent: descriptor.agent,
    cwd: descriptor.cwd,
    resume: descriptor.resume?.mode ?? 'new',
    source: descriptor.source,
    startId,
    stage,
    elapsedMs: Date.now() - startedAt,
  };
}

function errorStage(error: unknown): string {
  return error instanceof AppError && typeof error.context.stage === 'string' ? error.context.stage : 'unknown';
}

function logFields(descriptor: SessionStartDescriptor & { startId: string }): string {
  return `startId=${descriptor.startId} source=${descriptor.source} session=${descriptor.sessionId} agent=${descriptor.agent} cwd=${JSON.stringify(descriptor.cwd)} resume=${descriptor.resume?.mode ?? 'new'}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
