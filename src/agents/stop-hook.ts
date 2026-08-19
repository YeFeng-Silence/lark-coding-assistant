export function codexStyleStopHookArgs(command: string): string[] {
  const hook = `{hooks=[{type="command",command=${JSON.stringify(command)},timeout=5}]}`;
  return ['--dangerously-bypass-hook-trust', '-c', `hooks.Stop=[${hook}]`];
}

export function claudeStopHookArgs(command: string): string[] {
  return ['--settings', JSON.stringify({
    hooks: {
      Stop: [{ hooks: [{ type: 'command', command, timeout: 5 }] }],
    },
  })];
}
