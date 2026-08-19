import { describe, expect, it } from 'vitest';
import { resolveResumeOption } from '../src/agents/resume.js';
import { registrationDomains } from '../src/lark/registration.js';

describe('resolveResumeOption', () => {
  it('maps supported resume modes', () => {
    expect(resolveResumeOption({})).toBeUndefined();
    expect(resolveResumeOption({ resume: true })).toEqual({ mode: 'picker' });
    expect(resolveResumeOption({ resume: 'thread-id' })).toEqual({ mode: 'session', sessionId: 'thread-id' });
    expect(resolveResumeOption({ resumeLast: true })).toEqual({ mode: 'last' });
    expect(resolveResumeOption({ resumeAll: true })).toEqual({ mode: 'picker', all: true });
  });

  it('rejects conflicting resume modes', () => {
    expect(() => resolveResumeOption({ resume: true, resumeLast: true })).toThrow('cannot be used together');
  });
});

describe('registrationDomains', () => {
  it('starts on Feishu and keeps the Lark fallback domain for SDK tenant detection', () => {
    expect(registrationDomains).toEqual({
      domain: 'accounts.feishu.cn',
      larkDomain: 'accounts.larksuite.com',
    });
  });
});
