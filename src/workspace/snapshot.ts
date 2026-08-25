import { randomBytes } from 'node:crypto';
import type { WorkspaceCandidate } from './discovery.js';

export interface WorkspaceSnapshot {
  id: string;
  chatId: string;
  ownerOpenId: string;
  candidates: WorkspaceCandidate[];
  warnings: string[];
  partial: boolean;
  createdAt: number;
  expiresAt: number;
}

export class WorkspaceSnapshotStore {
  private readonly values = new Map<string, WorkspaceSnapshot>();

  constructor(
    private readonly ttlMs = 10 * 60_000,
    private readonly capacity = 64,
    private readonly now: () => number = Date.now,
    private readonly createId: () => string = () => randomBytes(12).toString('base64url'),
  ) {}

  create(input: Omit<WorkspaceSnapshot, 'id' | 'createdAt' | 'expiresAt'>): WorkspaceSnapshot {
    const now = this.now();
    this.prune(now);
    const snapshot: WorkspaceSnapshot = {
      ...input, id: this.createId(), createdAt: now, expiresAt: now + this.ttlMs,
    };
    this.values.set(snapshot.id, snapshot);
    while (this.values.size > this.capacity) {
      const oldest = this.values.keys().next().value as string | undefined;
      if (!oldest) break;
      this.values.delete(oldest);
    }
    return snapshot;
  }

  get(id: string, chatId: string, ownerOpenId: string): WorkspaceSnapshot | undefined {
    const now = this.now();
    this.prune(now);
    const value = this.values.get(id);
    return value?.chatId === chatId && value.ownerOpenId === ownerOpenId ? value : undefined;
  }

  private prune(now: number): void {
    for (const [id, value] of this.values) {
      if (value.expiresAt <= now) this.values.delete(id);
    }
  }
}
