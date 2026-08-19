import { describe, expect, it } from 'vitest';
import { claudeResumeArgs, resumeArgs } from '../../src/agents/resume.js';

describe('resumeArgs', () => {
  it('builds only supported Codex resume arguments', () => {
    expect(resumeArgs()).toEqual([]);
    expect(resumeArgs({ mode: 'picker' })).toEqual(['resume']);
    expect(resumeArgs({ mode: 'picker', all: true })).toEqual(['resume', '--all']);
    expect(resumeArgs({ mode: 'last' })).toEqual(['resume', '--last']);
    expect(resumeArgs({ mode: 'session', sessionId: 'thread-id' })).toEqual(['resume', 'thread-id']);
  });

  it('maps bridge resume modes to Claude Code flags', () => {
    expect(claudeResumeArgs()).toEqual([]);
    expect(claudeResumeArgs({ mode: 'picker' })).toEqual(['--resume']);
    expect(claudeResumeArgs({ mode: 'picker', all: true })).toEqual(['--resume']);
    expect(claudeResumeArgs({ mode: 'last' })).toEqual(['--continue']);
    expect(claudeResumeArgs({ mode: 'session', sessionId: 'session-id' })).toEqual(['--resume', 'session-id']);
  });
});
