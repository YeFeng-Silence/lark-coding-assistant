import type { AppPaths } from '../core/paths.js';
import { readUpdateStatus, type UpdateStatus } from './manager.js';

export async function waitForMaintenance(
  paths: AppPaths,
  pid: number,
  report: (status: UpdateStatus) => void,
  timeoutMs = 12 * 60_000,
): Promise<UpdateStatus> {
  const deadline = Date.now() + timeoutMs;
  let previous = '';
  while (Date.now() < deadline) {
    const status = await readUpdateStatus(paths);
    // A previous task's result can remain until this worker first writes status.
    if (status?.pid === pid) {
      const key = `${status.phase}:${status.message}`;
      if (key !== previous) { report(status); previous = key; }
      if (status.phase === 'success' || status.phase === 'failed') return status;
    }
    try { process.kill(pid, 0); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
        throw new Error('更新进程意外退出，请使用 lca status 或 logs/update.log 查看详情。');
      }
    }
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error('等待更新结果超时；后台任务可能仍在运行，请使用 lca status 查看进度。');
}
