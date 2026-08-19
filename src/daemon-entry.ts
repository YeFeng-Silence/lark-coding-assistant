import { AssistantDaemon } from './daemon/server.js';
import { resolveAppPaths } from './core/paths.js';
import { AppStore } from './core/store.js';
import { readFile } from 'node:fs/promises';

const paths = resolveAppPaths();
const packageInfo = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };
const daemon = new AssistantDaemon(
  new AppStore(paths), paths, undefined, undefined, undefined, undefined, packageInfo.version,
);

try {
  await daemon.start();
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      console.error(`${new Date().toISOString()} daemon received ${signal}; shutting down`);
      void daemon.close().finally(() => process.exit(0));
    });
  }
} catch (error) {
  console.error(`${new Date().toISOString()} daemon crashed during startup`, error);
  process.exitCode = 1;
}

process.on('uncaughtException', (error) => {
  console.error(`${new Date().toISOString()} daemon uncaught exception`, error);
  process.exit(1);
});

process.on('unhandledRejection', (error) => {
  console.error(`${new Date().toISOString()} daemon unhandled rejection`, error);
  process.exit(1);
});
