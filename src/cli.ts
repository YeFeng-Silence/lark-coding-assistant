import { randomBytes } from 'node:crypto';
import { access, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { Command } from 'commander';
import * as p from '@clack/prompts';
import { registerApp } from '@larksuite/channel';
import qrcode from 'qrcode-terminal';
import { resolveAppPaths } from './core/paths.js';
import { AppStore } from './core/store.js';
import type { AppConfig, Tenant } from './core/model.js';
import { runFile } from './platform/process.js';
import { requestDaemon } from './daemon/client.js';
import { resolveResumeOption } from './agents/resume.js';
import { getAgentAdapter, isAgentId } from './agents/registry.js';
import type { AgentId, ResumeOptions } from './agents/types.js';
import { daemonInfo, startDaemonProcess, stopDaemonProcess } from './daemon/lifecycle.js';
import { registrationDomains } from './lark/registration.js';

const program = new Command();
const paths = resolveAppPaths();
const store = new AppStore(paths);
const packageInfo = JSON.parse(
  await readFile(new URL('../package.json', import.meta.url), 'utf8'),
) as { version: string };

program.name('lark-coding-assistant').version(packageInfo.version);

program.command('init').description('Configure Feishu/Lark PersonalAgent').action(runInit);
program.command('start')
  .option('-n, --name <name>', 'Session name', 'default')
  .option('--agent <agent>', 'Coding agent (codex, trae-cli, or claude-code)', parseAgentId, 'codex')
  .option('--cwd <path>', 'Coding agent working directory')
  .option('--resume [session-id]', 'Resume agent session; omit the ID to open the picker')
  .option('--resume-last', 'Resume the most recent agent session in this working directory')
  .option('--resume-all', 'Show all agent sessions in the resume picker')
  .action(runStart);
program.command('attach').argument('[name]', 'Session name', 'default').description('Attach local terminal to coding-agent tmux session').action(runAttach);
program.command('bind-code').description('Generate a new one-time Lark binding code').action(runBindCode);
program.command('status').argument('[name]', 'Session name').description('Show daemon and session status').action(runStatus);
program.command('stop').argument('[name]', 'Session name').description('Stop managed coding-agent/tmux session').action(runStop);
program.command('logs').option('-n, --lines <count>', 'Number of lines', '100').action(runLogs);
program.command('reset-owner').description('Clear persistent Lark owner').action(runResetOwner);
const daemonCommand = program.command('daemon').description('Manage the Lark bridge daemon');
daemonCommand.command('start').description('Start the bridge daemon').action(runDaemonStart);
daemonCommand.command('stop').description('Stop the bridge daemon without stopping coding-agent sessions').action(runDaemonStop);
daemonCommand.command('restart').description('Restart the bridge daemon without stopping coding-agent sessions').action(runDaemonRestart);
daemonCommand.command('status').description('Show bridge daemon status and version').action(runDaemonStatus);

await program.parseAsync();

async function runInit(): Promise<void> {
  await store.ensure();
  const tenantAnswer = await p.select({
    message: '选择平台',
    options: [
      { value: 'feishu', label: '飞书' },
      { value: 'lark', label: 'Lark' },
    ],
  });
  if (p.isCancel(tenantAnswer)) return p.cancel('已取消');
  const tenant = tenantAnswer as Tenant;

  p.log.info('请使用飞书/Lark 扫描下面的二维码，创建或选择 PersonalAgent。');
  const registration = await registerApp({
    ...registrationDomains,
    source: 'lark-coding-assistant',
    appPreset: {
      name: 'Coding Assistant',
      desc: 'Bridge local coding-agent tmux sessions to private chat',
    },
    addons: {
      scopes: { tenant: ['im:message', 'im:message:send_as_bot'] },
      events: { items: { tenant: ['im.message.receive_v1'] } },
      callbacks: { items: ['card.action.trigger'] },
    },
    onQRCodeReady: ({ url, expireIn }) => {
      qrcode.generate(url, { small: true }, (output) => console.log(output));
      console.log(`二维码 ${Math.ceil(expireIn / 60)} 分钟内有效。若终端无法扫码，请打开：\n${url}\n`);
    },
    onStatusChange: ({ status }) => {
      if (status === 'domain_switched') p.log.info('已识别账号域，等待完成应用确认…');
    },
  });
  const registeredTenant = registration.user_info?.tenant_brand ?? tenant;
  const config: AppConfig = {
    tenant: registeredTenant,
    appId: registration.client_id,
    tmuxBinary: 'tmux',
    agentBinaries: { codex: 'codex', 'trae-cli': 'trae-cli', 'claude-code': 'claude' },
    pollIntervalMs: 650,
  };
  const previousState = await store.loadState();
  const registeredOwnerOpenId = registration.user_info?.open_id;
  const ownerChanged = Boolean(
    registeredOwnerOpenId
    && previousState.ownerOpenId
    && registeredOwnerOpenId !== previousState.ownerOpenId,
  );
  await Promise.all([
    store.saveConfig(config),
    store.saveSecrets({
      appSecret: registration.client_secret,
      callbackSecret: randomBytes(32).toString('base64url'),
    }),
    store.saveState({
      ...previousState,
      ownerOpenId: registeredOwnerOpenId ?? previousState.ownerOpenId,
      boundChatId: ownerChanged ? undefined : previousState.boundChatId,
      autoBindDisabled: false,
      updatedAt: Date.now(),
    }),
  ]);
  p.outro('PersonalAgent 配置已保存。');
}

interface StartOptions extends ResumeOptions {
  agent: AgentId;
  cwd?: string;
  name: string;
}

async function runStart(options: StartOptions): Promise<void> {
  const cwd = resolve(options.cwd ?? process.cwd());
  const resume = resolveResumeOption(options);
  await access(cwd);
  await ensureInitialized();
  await preflight(options.agent);
  await ensureDaemon();
  const response = await requestDaemon(paths.socket, {
    method: 'start', cwd, sessionId: options.name, agent: options.agent, resume,
  });
  if (!response.ok) throw new Error(response.error);
  const value = response.value as StartSessionValue;
  if (value.binding.mode === 'reused') {
    console.log('\n已自动沿用原有飞书/Lark 私聊绑定。\n');
  } else if (value.binding.mode === 'awaiting-owner-message') {
    console.log('\n打开飞书/Lark 私聊并直接发送消息即可自动连接，无需绑定码。\n');
  } else {
    console.log(`\n飞书/Lark 私聊绑定命令（${value.binding.expiresInSeconds / 60} 分钟有效）：`);
    console.log(`  /attach ${value.binding.bindCode}\n`);
  }
  if (!value.active) {
    console.log(`飞书当前仍连接其它 session；发送 /use ${options.name} 后切换到本 session。\n`);
  }
  await attachLocal(options.name);
}

interface StartSessionValue {
  active: boolean;
  binding:
    | { mode: 'reused' }
    | { mode: 'awaiting-owner-message' }
    | { mode: 'code'; bindCode: string; expiresInSeconds: number };
}

async function runAttach(name: string): Promise<void> {
  await attachLocal(name);
}

async function runBindCode(): Promise<void> {
  await ensureInitialized();
  await ensureDaemon();
  const response = await requestDaemon(paths.socket, { method: 'bindCode' });
  if (!response.ok) throw new Error(response.error);
  const value = response.value as { bindCode: string; expiresInSeconds: number };
  console.log(`飞书/Lark 私聊绑定命令（${value.expiresInSeconds / 60} 分钟有效）：`);
  console.log(`/attach ${value.bindCode}`);
}

async function attachLocal(name: string): Promise<void> {
  const state = await store.loadState();
  const config = await store.loadConfig();
  const session = state.sessions?.[name];
  if (!session) throw new Error(`no managed session: ${name}`);
  if (!config) throw new Error('not initialized');
  const child = spawn(config.tmuxBinary, ['attach-session', '-t', `=${session.sessionName}`], { stdio: 'inherit' });
  const code = await new Promise<number | null>((resolveExit, reject) => {
    child.once('error', reject);
    child.once('exit', resolveExit);
  });
  if (code && code !== 0) process.exitCode = code;
}

async function runStatus(name?: string): Promise<void> {
  try {
    const response = await requestDaemon(paths.socket, { method: 'status', sessionId: name });
    if (!response.ok) throw new Error(response.error);
    console.log(JSON.stringify(response.value, null, 2));
  } catch {
    const state = await store.loadState();
    console.log(JSON.stringify({ daemon: 'stopped', state }, null, 2));
  }
}

async function runStop(name?: string): Promise<void> {
  const response = await requestDaemon(paths.socket, { method: 'stop', sessionId: name });
  if (!response.ok) throw new Error(response.error);
  console.log(`Coding-agent tmux session stopped${name ? `: ${name}` : '.'}`);
}

async function runResetOwner(): Promise<void> {
  const response = await requestDaemon(paths.socket, { method: 'resetOwner' });
  if (!response.ok) throw new Error(response.error);
  console.log('Owner cleared.');
}

async function runLogs(options: { lines: string }): Promise<void> {
  const count = Math.max(1, Math.min(1000, Number.parseInt(options.lines, 10) || 100));
  const content = await readFile(paths.logFile, 'utf8').catch(() => '');
  console.log(content.split('\n').slice(-count).join('\n'));
}

async function runDaemonStart(): Promise<void> {
  await ensureInitialized();
  const before = await daemonInfo(paths);
  if (before?.version === packageInfo.version) {
    console.log(`Bridge daemon is already running (PID ${before.pid}, version ${before.version}).`);
    return;
  }
  if (before) await stopDaemonProcess(paths);
  const info = await startDaemonProcess(paths, daemonEntryPath());
  console.log(`Bridge daemon started (PID ${info.pid}, version ${info.version}).`);
}

async function runDaemonStop(): Promise<void> {
  const stopped = await stopDaemonProcess(paths);
  console.log(stopped ? 'Bridge daemon stopped. Coding-agent/tmux sessions were preserved.' : 'Bridge daemon is not running.');
}

async function runDaemonRestart(): Promise<void> {
  await ensureInitialized();
  await stopDaemonProcess(paths);
  const info = await startDaemonProcess(paths, daemonEntryPath());
  console.log(`Bridge daemon restarted (PID ${info.pid}, version ${info.version}). Coding-agent/tmux sessions were preserved.`);
}

async function runDaemonStatus(): Promise<void> {
  const info = await daemonInfo(paths);
  if (!info) {
    console.log(`Bridge daemon: stopped\nCLI version: ${packageInfo.version}`);
    return;
  }
  console.log([
    'Bridge daemon: running',
    `PID: ${info.pid}`,
    `Daemon version: ${info.version}`,
    `CLI version: ${packageInfo.version}`,
    `Up to date: ${info.version === packageInfo.version ? 'yes' : 'no'}`,
  ].join('\n'));
}

async function ensureInitialized(): Promise<void> {
  if (!await store.loadConfig() || !await store.loadSecrets()) {
    throw new Error('not initialized; run lark-coding-assistant init first');
  }
}

async function preflight(agentId: AgentId): Promise<void> {
  const config = (await store.loadConfig())!;
  const adapter = getAgentAdapter(agentId);
  await Promise.all([
    runFile(config.tmuxBinary, ['-V']),
    runFile(adapter.binary(config), [...adapter.versionArgs]),
  ]);
}

function parseAgentId(value: string): AgentId {
  if (!isAgentId(value)) throw new Error(`unsupported coding agent: ${value}`);
  return value;
}

async function ensureDaemon(): Promise<void> {
  const info = await daemonInfo(paths);
  if (info?.version === packageInfo.version) return;
  if (info) {
    console.log(`检测到 bridge daemon 版本 ${info.version}，正在更新到 ${packageInfo.version}…`);
    await stopDaemonProcess(paths);
  }
  await startDaemonProcess(paths, daemonEntryPath());
}

function daemonEntryPath(): string {
  return fileURLToPath(new URL('./daemon-entry.js', import.meta.url));
}
