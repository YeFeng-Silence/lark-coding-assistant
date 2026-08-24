import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isAgentId } from '../agents/registry.js';
import type { AgentId } from '../agents/types.js';
import type { ChoiceInteractionKind } from '../screen/detector.js';

export interface SignedAction {
  v: 1;
  kind: 'choice' | 'stop' | 'session' | 'session-stop' | 'session-create' | 'session-start-error'
    | 'startup-conflict' | 'resume-picker' | 'manual';
  interactionKind?: ChoiceInteractionKind;
  sessionId?: string;
  manualMode?: 'explicit' | 'fallback';
  agent: AgentId;
  action: string;
  paneId: string;
  fingerprint: string;
  chatId: string;
  nonce: string;
  expiresAt: number;
  sig: string;
}

type UnsignedAction = Omit<SignedAction, 'v' | 'nonce' | 'expiresAt' | 'sig'>;
const APPROVAL_NONCE_RETENTION_MS = 7 * 24 * 60 * 60_000;

function remainsValidWhilePending(kind: SignedAction['kind']): boolean {
  return kind === 'choice';
}

export class ActionSigner {
  private readonly usedNonces = new Map<string, number>();

  constructor(private readonly secret: string, private readonly now: () => number = Date.now) {}

  sign(action: UnsignedAction, ttlMs = 5 * 60_000): SignedAction {
    const value: Omit<SignedAction, 'sig'> = {
      v: 1,
      ...action,
      nonce: randomBytes(18).toString('base64url'),
      expiresAt: this.now() + ttlMs,
    };
    return { ...value, sig: this.mac(value) };
  }

  verify(value: unknown, expectedChatId?: string): SignedAction | undefined {
    const now = this.now();
    this.prune(now);
    if (!isSignedAction(value)
      || (expectedChatId && value.chatId !== expectedChatId)
      || (!remainsValidWhilePending(value.kind) && value.expiresAt < now)
      || this.usedNonces.has(value.nonce)) return undefined;
    const expected = Buffer.from(this.mac(withoutSignature(value)), 'base64url');
    const actual = Buffer.from(value.sig, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) return undefined;
    this.usedNonces.set(
      value.nonce,
      remainsValidWhilePending(value.kind) ? Math.max(value.expiresAt, now + APPROVAL_NONCE_RETENTION_MS) : value.expiresAt,
    );
    return value;
  }

  private mac(value: Omit<SignedAction, 'sig'>): string {
    const canonical = JSON.stringify([
      value.v,
      value.kind,
      value.interactionKind ?? null,
      value.sessionId ?? null,
      value.manualMode ?? null,
      value.agent,
      value.action,
      value.paneId,
      value.fingerprint,
      value.chatId,
      value.nonce,
      value.expiresAt,
    ]);
    return createHmac('sha256', this.secret).update(canonical).digest('base64url');
  }

  private prune(now: number): void {
    for (const [nonce, expiresAt] of this.usedNonces) {
      if (expiresAt < now) this.usedNonces.delete(nonce);
    }
  }
}

function withoutSignature(value: SignedAction): Omit<SignedAction, 'sig'> {
  const { sig: _sig, ...unsigned } = value;
  return unsigned;
}

function isSignedAction(value: unknown): value is SignedAction {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  return item.v === 1
    && (item.kind === 'choice' || item.kind === 'stop' || item.kind === 'session' || item.kind === 'session-stop'
      || item.kind === 'session-create' || item.kind === 'session-start-error' || item.kind === 'startup-conflict'
      || item.kind === 'resume-picker' || item.kind === 'manual')
    && (item.kind !== 'choice' || item.interactionKind === 'approval' || item.interactionKind === 'question' || item.interactionKind === 'choice')
    && (item.kind !== 'manual' || (typeof item.sessionId === 'string'
      && (item.manualMode === 'explicit' || item.manualMode === 'fallback')))
    && ((item.kind !== 'session-stop' && item.kind !== 'session-start-error'
      && item.kind !== 'resume-picker' && item.kind !== 'startup-conflict')
      || typeof item.sessionId === 'string')
    && typeof item.agent === 'string'
    && isAgentId(item.agent)
    && typeof item.action === 'string'
    && typeof item.paneId === 'string'
    && typeof item.fingerprint === 'string'
    && typeof item.chatId === 'string'
    && typeof item.nonce === 'string'
    && typeof item.expiresAt === 'number'
    && typeof item.sig === 'string';
}
