import { describe, expect, it } from 'vitest';
import { WorkspaceSnapshotStore } from '../../src/workspace/snapshot.js';

describe('WorkspaceSnapshotStore', () => {
  it('binds snapshots to chat and owner and expires them', () => {
    let now = 100;
    let id = 0;
    const store = new WorkspaceSnapshotStore(1_000, 2, () => now, () => `id-${++id}`);
    const snapshot = store.create({ chatId: 'oc_1', ownerOpenId: 'ou_1', candidates: [], warnings: [], partial: false });
    expect(store.get(snapshot.id, 'oc_1', 'ou_1')).toBe(snapshot);
    expect(store.get(snapshot.id, 'oc_2', 'ou_1')).toBeUndefined();
    now = 1_100;
    expect(store.get(snapshot.id, 'oc_1', 'ou_1')).toBeUndefined();
  });

  it('evicts the oldest snapshot at capacity', () => {
    let id = 0;
    const store = new WorkspaceSnapshotStore(10_000, 2, () => 1, () => `id-${++id}`);
    const one = store.create({ chatId: 'c', ownerOpenId: 'u', candidates: [], warnings: [], partial: false });
    store.create({ chatId: 'c', ownerOpenId: 'u', candidates: [], warnings: [], partial: false });
    store.create({ chatId: 'c', ownerOpenId: 'u', candidates: [], warnings: [], partial: false });
    expect(store.get(one.id, 'c', 'u')).toBeUndefined();
  });
});
