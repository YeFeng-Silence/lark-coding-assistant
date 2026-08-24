import { describe, expect, it } from 'vitest';
import { parseResumePicker } from '../../src/screen/resume-picker.js';

describe('native Resume Picker parser', () => {
  it.each(['codex', 'traex'] as const)('parses %s visible choices', (agent) => {
    const screen = `
 Resume a previous session

 Type to search                   Filter:  All [Cwd]   Sort: [Updated] Created

  ❯ 5d ago      北京天气
    5d ago      现在时间
    6d ago      珠海今天天气

───────────────────────────────────────────────────────────────── 1 / 3 · 100% ─
 enter resume   esc new   ctrl+c quit   ↑/↓ browse
`;
    const picker = parseResumePicker(screen, agent);
    expect(picker).toMatchObject({
      agent, selectedIndex: 0, position: 1, total: 3, canPrevious: false, canNext: false,
    });
    expect(picker?.options.map(({ label, selected }) => ({ label, selected }))).toEqual([
      { label: '北京天气', selected: true },
      { label: '现在时间', selected: false },
      { label: '珠海今天天气', selected: false },
    ]);
  });

  it('parses Claude two-line choices and skips partial scroll indicators', () => {
    const picker = parseResumePicker(`
────────────────────────────────────────────────────────────────────────────────
  Resume session (1 of 6)
  ╭──────────────────────────────────────────────────────────────────────────╮
  │ ⌕ Search…                                                                │
  ╰──────────────────────────────────────────────────────────────────────────╯
    test

  ❯ /exit
    3 days ago · HEAD · 15.8KB

    权限审批问题
    4 days ago · HEAD · 1.2MB

  ↓ hidden item
    5 days ago · HEAD · 4.9KB

    Ctrl+A to show all projects · Type to search · Esc to cancel
`, 'claude');
    expect(picker).toMatchObject({
      agent: 'claude', selectedIndex: 0, position: 1, total: 6, canPrevious: false, canNext: true,
    });
    expect(picker?.options.map(({ label }) => label)).toEqual(['/exit', '权限审批问题']);
  });

  it('parses the current Claude picker without an item count in its header', () => {
    const picker = parseResumePicker(`
────────────────────────────────────────────────────────────────────────────────
  Resume session
  ╭──────────────────────────────────────────────────────────────────────────╮
  │ ⌕ Search…                                                                │
  ╰──────────────────────────────────────────────────────────────────────────╯
    test

  ❯ /exit
    4 days ago · HEAD · 15.9KB

    /exit
    4 days ago · HEAD · 15.8KB

    权限审批问题
    4 days ago · HEAD · 1.2MB

    claude update
    5 days ago · HEAD · 63.3KB

    Ctrl+A to show all projects · Ctrl+B to only show current branch · Space to preview · Ctrl+R to rename · Type to
    search · Esc to cancel
`, 'claude');
    expect(picker).toMatchObject({
      agent: 'claude', selectedIndex: 0, position: undefined, total: undefined,
      canPrevious: false, canNext: false,
    });
    expect(picker?.options.map(({ label }) => label)).toEqual([
      '/exit', '/exit', '权限审批问题', 'claude update',
    ]);
  });

  it('uses Claude scroll indicators when the current picker omits counts', () => {
    const picker = parseResumePicker(`
  Resume session
  ╭──────────────────────────────────────────────────────────────────────────╮
  │ ⌕ Search…                                                                │
  ╰──────────────────────────────────────────────────────────────────────────╯
  ↑ earlier sessions

  ❯ Current
    1 day ago · HEAD · 1KB

    Next
    2 days ago · HEAD · 2KB

  ↓ later sessions
    Ctrl+A to show all projects · Type to search · Esc to cancel
`, 'claude');
    expect(picker).toMatchObject({ canPrevious: true, canNext: true });
    expect(picker?.options.map(({ label }) => label)).toEqual(['Current', 'Next']);
  });

  it('does not classify ordinary agent output as a picker', () => {
    expect(parseResumePicker('› Ask Codex to do anything', 'codex')).toBeUndefined();
  });

  it.each(['codex', 'traex'] as const)('shows navigation for hidden %s choices only', (agent) => {
    const picker = parseResumePicker(`
 Resume a previous session

 Type to search                   Filter:  All [Cwd]   Sort: [Updated] Created

    4d ago      First visible
  ❯ 5d ago      Current visible
    6d ago      Last visible

───────────────────────────────────────────────────────────────── 4 / 6 · 67% ─
 enter resume   esc new   ctrl+c quit   ↑/↓ browse
`, agent);
    expect(picker).toMatchObject({
      position: 4, total: 6, selectedIndex: 1, canPrevious: true, canNext: true,
    });

    const last = parseResumePicker(`
 Resume a previous session

 Type to search                   Filter:  All [Cwd]   Sort: [Updated] Created

    4d ago      Fourth
    5d ago      Fifth
  ❯ 6d ago      Sixth

───────────────────────────────────────────────────────────────── 6 / 6 · 100% ─
 enter resume   esc new   ctrl+c quit   ↑/↓ browse
`, agent);
    expect(last).toMatchObject({
      position: 6, total: 6, selectedIndex: 2, canPrevious: true, canNext: false,
    });
  });

  it('hides Claude navigation when every choice is already visible', () => {
    const picker = parseResumePicker(`
────────────────────────────────────────────────────────────────────────────────
  Resume session (1 of 2)
  ╭──────────────────────────────────────────────────────────────────────────╮
  │ ⌕ Search…                                                                │
  ╰──────────────────────────────────────────────────────────────────────────╯
  ❯ First
    1 day ago · HEAD · 1KB

    Second
    2 days ago · HEAD · 2KB

    Ctrl+A to show all projects · Type to search · Esc to cancel
`, 'claude');
    expect(picker).toMatchObject({
      position: 1, total: 2, canPrevious: false, canNext: false,
    });
  });
});
