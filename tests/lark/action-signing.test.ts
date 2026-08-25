import { describe, expect, it } from 'vitest';
import { ActionSigner } from '../../src/lark/action-signing.js';

describe('ActionSigner', () => {
  it('accepts a signed action once and rejects replay', () => {
    const signer = new ActionSigner('secret', () => 1000);
    const action = signer.sign({ kind: 'choice', interactionKind: 'approval', agent: 'codex', action: '1', paneId: '%1', fingerprint: 'abc', chatId: 'oc_1' });
    expect(signer.verify(action)).toEqual(action);
    expect(signer.verify(action)).toBeUndefined();
  });

  it('rejects tampering and expiry', () => {
    let now = 1000;
    const signer = new ActionSigner('secret', () => now);
    const action = signer.sign({ kind: 'stop', agent: 'codex', action: 'confirm', paneId: '%1', fingerprint: 'abc', chatId: 'oc_1' }, 50);
    expect(signer.verify({ ...action, paneId: '%2' })).toBeUndefined();
    now = 1051;
    expect(signer.verify(action)).toBeUndefined();
  });

  it('keeps an approval usable while the exact Codex approval screen is still pending', () => {
    let now = 1000;
    const signer = new ActionSigner('secret', () => now);
    const action = signer.sign({
      kind: 'choice', interactionKind: 'approval', agent: 'codex', action: '1', paneId: '%1', fingerprint: 'abc', chatId: 'oc_1',
    }, 50);
    now = 24 * 60 * 60_000;
    expect(signer.verify(action, 'oc_1')).toEqual(action);
    expect(signer.verify(action, 'oc_1')).toBeUndefined();
  });

  it('keeps a Question answer usable while the exact question is still pending', () => {
    let now = 1000;
    const signer = new ActionSigner('secret', () => now);
    const action = signer.sign({
      kind: 'choice', interactionKind: 'question', agent: 'traex', action: '2', paneId: '%1', fingerprint: 'question', chatId: 'oc_1',
    }, 50);
    now = 24 * 60 * 60_000;
    expect(signer.verify(action, 'oc_1')).toEqual(action);
  });

  it('still expires session and stop actions', () => {
    let now = 1000;
    const signer = new ActionSigner('secret', () => now);
    const session = signer.sign({
      kind: 'session', agent: 'codex', action: 'backend', paneId: '%1', fingerprint: 'abc', chatId: 'oc_1',
    }, 50);
    const stop = signer.sign({
      kind: 'stop', agent: 'codex', action: 'confirm', paneId: '%1', fingerprint: 'abc', chatId: 'oc_1',
    }, 50);
    now = 1051;
    expect(signer.verify(session, 'oc_1')).toBeUndefined();
    expect(signer.verify(stop, 'oc_1')).toBeUndefined();
  });

  it('rejects a forwarded card without consuming its nonce', () => {
    const signer = new ActionSigner('secret', () => 1000);
    const action = signer.sign({ kind: 'choice', interactionKind: 'approval', agent: 'codex', action: '1', paneId: '%1', fingerprint: 'abc', chatId: 'oc_owner' });
    expect(signer.verify(action, 'oc_forwarded')).toBeUndefined();
    expect(signer.verify(action, 'oc_owner')).toEqual(action);
  });

  it('does not depend on JSON object property order', () => {
    const signer = new ActionSigner('secret', () => 1000);
    const action = signer.sign({ kind: 'choice', interactionKind: 'approval', agent: 'codex', action: '1', paneId: '%1', fingerprint: 'abc', chatId: 'oc_1' });
    const reordered = JSON.parse(JSON.stringify(action, Object.keys(action).reverse())) as unknown;
    expect(signer.verify(reordered)).toBeDefined();
  });

  it('signs and verifies a session selection action', () => {
    const signer = new ActionSigner('secret', () => 1000);
    const action = signer.sign({
      kind: 'session', agent: 'traex', action: 'backend', paneId: '%2', fingerprint: '123', chatId: 'oc_1',
    });
    expect(signer.verify(action, 'oc_1')).toEqual(action);
  });

  it('binds session-create actions to a workspace snapshot and page', () => {
    const signer = new ActionSigner('secret', () => 1000);
    const action = signer.sign({
      kind: 'session-create', agent: 'codex', action: 'next', paneId: '', fingerprint: 'create', chatId: 'oc_1',
      snapshotId: 'snapshot-1', page: 2,
    });
    expect(signer.verify({ ...action, page: 3 }, 'oc_1')).toBeUndefined();
    expect(signer.verify({ ...action, snapshotId: 'snapshot-2' }, 'oc_1')).toBeUndefined();
    expect(signer.verify(action, 'oc_1')).toEqual(action);
  });

  it('signs manual actions with a bound session and rejects tampering', () => {
    const signer = new ActionSigner('secret', () => 1000);
    const action = signer.sign({
      kind: 'manual', sessionId: 'assistant', manualMode: 'explicit', agent: 'codex', action: 'enter',
      paneId: '%1', fingerprint: 'screen-1', chatId: 'oc_1',
    });
    expect(signer.verify({ ...action, sessionId: 'other' }, 'oc_1')).toBeUndefined();
    expect(signer.verify(action, 'oc_1')).toEqual(action);
  });

  it('binds resume and stop actions to one LCA session', () => {
    const signer = new ActionSigner('secret', () => 1000);
    for (const kind of ['resume-picker', 'session-stop', 'session-start-error', 'startup-conflict'] as const) {
      const action = signer.sign({
        kind, sessionId: 'restore', agent: 'codex', action: 'confirm', paneId: '%9', fingerprint: 'fp', chatId: 'oc_1',
      });
      expect(signer.verify({ ...action, sessionId: 'other' }, 'oc_1')).toBeUndefined();
      expect(signer.verify(action, 'oc_1')).toEqual(action);
    }
  });
});
