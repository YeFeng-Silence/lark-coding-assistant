import { resolveAppPaths } from './core/paths.js';
import { performMaintenance } from './update/manager.js';
const [root, packageRoot, action] = process.argv.slice(2);
if (!root || !packageRoot || (action !== 'update' && action !== 'restart')) throw new Error('Invalid maintenance arguments');
await performMaintenance(resolveAppPaths(root), packageRoot, action);
