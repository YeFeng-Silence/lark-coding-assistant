import { describe, expect, it } from 'vitest';
import { choiceNavigation } from '../../src/screen/choice.js';
import type { ScreenAction } from '../../src/screen/detector.js';

const actions: ScreenAction[] = [
  { id: 'option-1', key: '1', label: 'First', focused: false },
  { id: 'option-2', key: '2', label: 'Second', focused: true },
  { id: 'option-3', key: '3', label: 'Third', focused: false },
  { id: 'option-4', key: '4', label: 'Fourth', focused: false },
];

describe('choice navigation', () => {
  it('submits the currently selected option', () => {
    expect(choiceNavigation(actions, '2')).toEqual(['Enter']);
  });

  it('moves down to a later option before submitting', () => {
    expect(choiceNavigation(actions, '4')).toEqual(['Down', 'Down', 'Enter']);
  });

  it('moves up to an earlier option before submitting', () => {
    expect(choiceNavigation(actions, '1')).toEqual(['Up', 'Enter']);
  });

  it('rejects missing targets or ambiguous selections', () => {
    expect(choiceNavigation(actions, '9')).toBeUndefined();
    expect(choiceNavigation(actions.map((action) => ({ ...action, focused: false })), '1')).toBeUndefined();
  });
});
