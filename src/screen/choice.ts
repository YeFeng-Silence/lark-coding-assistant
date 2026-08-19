import type { ScreenAction } from './detector.js';

export function choiceNavigation(actions: ScreenAction[], targetKey: string): string[] | undefined {
  const selectedIndex = actions.findIndex((action) => action.focused);
  const targetIndex = actions.findIndex((action) => action.key === targetKey);
  if (selectedIndex === -1 || targetIndex === -1) return undefined;
  const direction = targetIndex >= selectedIndex ? 'Down' : 'Up';
  return [
    ...Array.from({ length: Math.abs(targetIndex - selectedIndex) }, () => direction),
    'Enter',
  ];
}
