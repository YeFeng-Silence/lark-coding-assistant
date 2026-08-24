# lark-coding-assistant

`lark-coding-assistant` 是一个轻量的本地桥接工具：它把 codex、traex 或 claude 运行在受管 tmux session 中，让本地终端与飞书/Lark PersonalAgent 私聊操作同一个 coding agent 上下文。

远程消息、交互选择、查看输出和恢复现场都通过精确绑定的 tmux pane 完成；任务通知由 agent 原生 `Stop` hook 与终端停止输出状态共同确认。

## 主要能力

- codex、traex 与 claude 可混合运行，默认使用 codex；
- 支持多个命名 session，一个飞书账号可在 `/sessions` 卡片中直接切换或新建；
- 普通飞书消息默认发送到当前 active session；
- 支持 `/tail`、`/status`、`/stop`、远程处理审批与 Question，以及无法识别画面的手动遥控兜底；
- 本地终端保持 attach 时，飞书仍可操作同一个 TUI；
- 首次扫码后保存唯一 owner，后续通常无需绑定码；
- 交互卡点击后原地更新，保留操作结果与处理时间；
- daemon 单实例运行，可单独在后台启动；升级 CLI 时自动更新 daemon，tmux session 不受影响；
- daemon 会从 tmux 元数据恢复仍在运行但尚未登记的受管 session。
- 同一个 Agent 原生 session 只允许由一个存活的 LCA session 占用；重复恢复时会停止新 pane，并提示连接已有 session。

远程审批不按 codex、traex 或 claude 版本号限制。bridge 只有在当前 TUI 被高置信度识别为结构化交互，并且选项、默认光标和提交按键映射完整时才发送飞书交互卡。

## 环境要求

- macOS 或 Linux
- Node.js 20.12+
- tmux
- codex、traex 和/或 claude
- 可访问飞书或 Lark Open Platform

检查环境：

```bash
node --version
tmux -V
codex --version
trae-cli --version
claude --version
```

只需安装实际使用的 coding agent。

### 推荐的 coding agent 版本

以下版本已完成 Stop hook、任务通知、审批、Question、单选/多选和手动遥控回归，建议优先使用：

| Coding agent | 推荐版本 | 版本命令 |
| --- | --- | --- |
| codex | `0.148.0` | `codex --version` |
| traex | `0.201.5` | `trae-cli --version` |
| claude | `2.1.241` | `claude --version` |

这些是已验证的推荐版本，不是强制版本锁定。其他版本通常也可以运行；如果新版调整了 TUI 文案或按键交互，结构化卡片可能暂时无法识别，此时仍可通过 `/tail` 和手动遥控模式完成操作。

## 一键安装与初始化

```bash
npm install -g lark-coding-assistant@latest && lark-coding-assistant init
```

初始化向导会让你选择飞书或 Lark，并显示 PersonalAgent 注册二维码：

1. 保持 `init` 命令运行；
2. 使用飞书/Lark 扫描二维码；
3. 创建或选择 PersonalAgent；
4. 确认应用权限、事件和卡片回调；
5. 等待终端显示配置已保存。

二维码和链接是本次初始化临时生成的，请在有效期内完成。选择 Lark 后注册链接可能先显示飞书域名，识别账号后会自动切换授权域。

配置保存在 `~/.lark-coding-assistant`。App Secret 只写入本机 `secrets.json`，文件权限为 `0600`。

安装后可使用完整命令 `lark-coding-assistant`，也可使用等价的短命令 `lca`。下文示例优先使用 `lca`。

## 快速开始

默认启动 codex，并立即 attach：

```bash
cd ~/workspace/my-project
lca start
```

启动 traex：

```bash
lca start --agent traex
```

启动 claude：

```bash
lca start --agent claude
```

程序会启动唯一 bridge daemon、创建 `default` tmux session、向 agent 注入 `Stop` hook，然后 attach 当前终端。打开 PersonalAgent 私聊直接发消息即可自动连接，不需要先 detach，通常也不需要绑定码。

codex 与 traex 会使用其面向自动化的 `--dangerously-bypass-hook-trust` 参数运行 bridge 固定注入的 Stop hook，避免每次新建 session 都出现 hook 信任确认。这个参数只影响 hook 信任，不会关闭 agent 自身的命令审批。

## 多 agent、多 session

每个 session 必须使用唯一名称：

```bash
lca start --name api --agent codex --cwd ~/workspace/api
lca start --name web --agent traex --cwd ~/workspace/web
lca start --name docs --agent claude --cwd ~/workspace/docs
```

名称只允许字母、数字、下划线和短横线，最长 40 个字符。不指定名称时使用 `default`。

一个 PersonalAgent 私聊同一时刻只连接一个 active session。在飞书发送：

```text
/sessions
```

机器人会发送一张交互卡，按 codex、traex、claude 分组展示仍存活的 session，并显示每个项目的绝对路径。`● 当前` 表示 active session，点击其他 session 的“连接”按钮即可切换，点击“关闭”可停止对应 agent 和 tmux session；也可点击“新建 Session”，填写名称、Agent、绝对工作目录和恢复方式。创建成功后会自动连接；原 session 列表仍可查看、连接和关闭，只会禁用已经使用过的“新建 Session”按钮。也可使用：

```text
/use web
```

切换只改变飞书消息和通知的路由，不会停止其他 session。普通消息、`/tail`、`/status`、审批、`/stop` 和停止输出通知都只作用于 active session。

## 恢复 agent 历史会话

恢复参数同时适用于三个 agent，bridge 会转换为各 CLI 的原生参数：

```bash
# 打开当前工作目录的历史会话选择器
lca start --agent codex --resume

# 恢复最近会话
lca start --agent traex --resume-last

# 按 agent session ID 恢复
lca start --agent traex --resume <session-id>

# claude：恢复最近会话
lca start --agent claude --resume-last

# 选择器显示其他工作目录的会话
lca start --agent codex --resume-all
```

`--name` 是 bridge 管理的 tmux session 名；`--resume <session-id>` 是 coding agent 自己的历史 session ID，两者不是同一个概念。claude 的 `--resume-all` 与 `--resume` 都会打开其原生恢复选择器。

飞书只提供两种恢复方式：新会话，或打开 agent 原生 Resume Picker。选择 Resume Picker 后，bridge 会读取 codex、traex 或 claude 当前展示的历史会话列表并生成飞书卡片供选择；不会要求在飞书输入历史 Session ID，也不会直接把原始 picker 交给手动遥控。卡片会显示当前位置与总数，只有存在未展示的候选项时才出现翻页按钮。新旧版本 claude 的 Resume Picker 标题格式均可识别。

启动结果、session 列表、状态卡片和失败提示中的工作目录统一显示绝对路径。Resume Picker 启动失败时，失败卡片会提供“新建 Session”和“查看 Sessions”入口，原 session 列表不会因此失效。

## 本地终端与 tmux

本地保持 attach 不影响飞书操作。如果要暂时离开 tmux，按 `Ctrl-b`，松开后再按 `d`。这只会 detach 本地终端，不会停止 agent 或 daemon。

重新进入：

```bash
lca attach default
lca attach web
```

不要把 tmux detach 与飞书 `/detach` 混淆：前者只离开本地界面，后者会解除私聊绑定并关闭自动重连。

## 飞书/Lark 私聊命令

- `/sessions`：按 agent 分组展示所有仍存活的 session 及其绝对路径，可直接连接、关闭或打开新建表单。
- `/start`：直接打开新建 Session 表单。
- `/start <name> --agent <codex|traex|claude> --cwd <绝对路径> [--resume]`：用文本命令启动并自动连接新 session；包含空格的路径请加引号。使用 `--resume` 会打开原生 Resume Picker。飞书端不支持“恢复上次”或直接输入历史 Session ID。
- `/use <name>`：用文本命令切换 session。
- `/tail [20-300]`：返回当前 session 最近的终端输出，默认 80 行。
- `/manual`：打开当前 active session 的手动终端遥控卡。
- `/key up|down|left|right|enter|esc|tab|space|backspace|ctrl-c`：向当前终端发送一个手动按键。
- `/type <文本>`：向当前终端输入文本但不提交。
- `/submit <文本>`：向当前终端输入文本并按一次 Enter。
- `/status`：显示当前 session、agent、tmux pane、画面状态和工作目录。
- `/detach`：解除当前私聊绑定，agent 与 tmux 继续运行。
- `/stop`：发送二次确认卡，确认后关闭当前 agent 和 tmux session。
- `/attach <code>`：使用一次性绑定码重新绑定私聊。

常见画面状态包括 `idle`、`running`、`approval`、`input`、`failed`、`exited` 和 `unknown`。审批、Question 和其他结构化编号选择会根据当前终端画面生成交互卡；画面无法安全识别时不会盲目提交操作。

## 本地命令

```bash
# 启动和进入
lca start [--name <name>] [--agent codex|traex|claude] [--cwd <path>] [--resume [session-id]|--resume-last|--resume-all]
lca attach [name]

# 状态和停止
lca status [name]
lca stop [name]

# 私聊绑定
lca bind-code
lca reset-owner

# 日志
lca logs
lca logs --lines 300

# bridge daemon
lca daemon          # 仅启动后台 bridge daemon
lca daemon status
lca daemon stop
lca daemon restart
```

`daemon stop/restart` 只断开或恢复飞书连接，不停止受管 tmux session。顶层 `stop [name]` 才会停止对应 agent 和 tmux session。

## 绑定规则

首次扫码会保存可信 owner。后续启动会自动沿用该 owner 和私聊，通常不再需要绑定码。

以下情况才需要 `lca bind-code`：

- 曾在飞书发送 `/detach`；
- 需要迁移到另一个私聊；
- 当前配置没有保存 owner 身份。

绑定码是 10 分钟有效的一次性命令，只在本地保存 scrypt 哈希：

```text
/attach <一次性绑定码>
```

## 交互卡与消息排队

当 active agent 显示结构化编号选择时，bridge 会从当前终端画面识别标题、上下文、选项、光标位置、勾选状态和提交方式，并在飞书发送对应的审批、Question 或通用选择卡。卡片选项直接来自当前 TUI，不使用固定的按钮集合。

识别结果会先归一化为与 agent 无关的交互语义：单选或多选、选择切换键、最终提交方式，以及可选的补充内容编辑器。后续卡片渲染和 tmux 操作只消费这些语义，不按 codex、traex 或 claude 分别实现提交流程。各 agent 的适配层只负责识别终端文案与按键提示，因此未来版本只要仍能明确展示选项状态和提交方式，就可以复用同一套执行逻辑。

单选会直接提交所选答案；多选采用事务式表单，勾选、取消和修改自定义内容只保存在飞书卡片中，不会逐项操作本地终端。只有点击“提交答案”后，bridge 才会一次读取完整表单、同步本地 CLI 的最终选择和自定义内容，并执行一次提交。如果 agent 随后显示 `Submit answers / Cancel` 等二次确认，原卡片会继续刷新为新的确认卡。“继续对话”等非答案操作仍即时同步。远程操作引起的输入、光标移动和勾选变化只更新原卡片，不会重复推送新的交互卡。

点击卡片时会重新校验：

- 操作者仍是 owner；
- agent、active session 和 pane 没有变化；
- 交互内容、勾选状态和画面修订号仍与发卡时一致；
- 卡片签名和 nonce 有效。

交互卡不会仅因等待时间较长而失效；只要同一个选择画面仍在等待，即使隔夜也可处理。画面、pane、agent 或 active session 变化后旧卡会立即失效。停止和 session 选择卡仍使用短时有效期。

codex、traex、claude 的审批、Question 和其他编号选择统一使用同一套结构化识别与画面指纹校验；无法完整识别时不会盲目生成操作按钮。

## 手动遥控兜底

当 active pane 的输出稳定 3 秒、状态为 `input` 或 `unknown`，且 bridge 无法生成高置信度结构化操作卡时，会自动发送一张手动遥控卡。同一个 session、pane 和画面指纹只通知一次；也可以随时发送 `/manual` 主动打开。

手动遥控卡直接展示最近的终端输出，支持方向键、Enter、Esc、Tab、Space、Ctrl+C、仅输入文本和输入后提交。每次操作只向当前 tmux pane 发送一个原子动作，然后在原卡片刷新最新画面。除“刷新”外，所有操作都会校验 owner、active session、agent、pane 和画面指纹；画面已变化时不会执行旧操作，而是先刷新卡片让用户重新确认。

手动模式不会判断某个按键在当前 TUI 中是否安全，因此只应在确认终端画面后操作。点击“退出手动模式”只会禁用当前遥控卡，不会停止 coding agent 或 tmux。若重新识别到结构化审批或 Question，遥控卡会停止操作并恢复发送语义化交互卡。

agent 正在审批、本地输入框已有草稿或画面未知时，普通消息会进入最多 100 条的内存 FIFO 队列。恢复安全输入状态后按顺序发送；daemon 重启、`/detach`、切换或停止 session 时队列清空。

## “等待用户输入”通知

通知触发和通知内容提取是两条独立逻辑：

1. agent 原生 `Stop` hook 产生候选完成；
2. daemon 继续观察 active tmux pane；
3. 只有画面回到 `idle` 且连续 2.5 秒没有新输出，才确认 agent 已停止输出；
4. 多个中间完成事件会合并，只发送最新一条；
5. 确认发送时统一使用完成事件中的 `last-assistant-message` 作为最终回复。

因此终端画面只负责确认 agent 已停止输出，不再用于提取通知正文。非 active session 的完成事件不会推送。

## 升级与卸载

```bash
npm install -g lark-coding-assistant@latest
lca daemon restart
```

如果升级后直接执行 `start`，CLI 会自动比较自身与 daemon 版本并优雅更新 daemon，不停止现有 tmux session。

卸载：

```bash
npm uninstall -g lark-coding-assistant
```

## 数据目录

```text
~/.lark-coding-assistant/
├── config.json
├── secrets.json
├── state.json
├── logs/assistant.log
└── runtime/daemon.{pid,sock}
```

daemon 的常规日志、stdout、stderr 和启动崩溃都会写入 `logs/assistant.log`。

## 错误与调试

CLI 默认只显示简洁的中文错误和可执行的解决建议，不会把 Node.js 堆栈、源码路径或内部异常直接输出到终端。例如 session 已经运行时，可以按提示连接现有 session 或换一个名称。

查看 daemon 状态和日志：

```bash
lark-coding-assistant daemon status
lark-coding-assistant logs
```

需要排查未知异常时，可以只为当前命令开启调试输出：

```bash
LARK_CODING_ASSISTANT_DEBUG=1 lark-coding-assistant <command>
```

调试模式会在友好提示后追加原始错误堆栈，请勿把可能包含本机路径或环境信息的完整输出直接发布到公开渠道。

## 常见问题

### 飞书消息进入了错误的 session

发送 `/sessions`，查看 `● 当前` 并点击目标 session。普通消息永远只进入 active session。

### 没收到某个 session 的完成通知

只有 active session 会主动推送。session 必须由当前 CLI 创建，才能注入统一的 `Stop` hook。

### 消息提示已排队

通常是 agent 正在审批、本地输入框已有草稿或画面无法识别。发送 `/tail` 查看当前状态。

### 卡片或按钮显示已失效

说明卡片有效期已过，或 agent、active session、pane、交互画面、nonce 已变化。bridge 会尽量把原卡片更新为带有“卡片已失效”提示的只读状态；如果平台拒绝更新，则发送文字提示。请重新发送对应命令获取新卡：session 操作使用 `/sessions`，审批或 Question 可先用 `/tail` 确认当前画面并等待新卡。

### 关闭本地终端后 session 还在吗

关闭 attach 的终端通常不会停止 tmux，可用 `lark-coding-assistant attach <name>` 恢复。电脑关机、tmux server 被终止或 agent 自身退出后无法继续。

agent 或对应 tmux pane 退出后，daemon 会在下一次轮询中自动从 `state.json` 移除该 session；如果退出的是 active session，会先发送退出通知，再切换到其他仍存活的 session。

### 完全重新配置 PersonalAgent

重新运行 `lark-coding-assistant init`。如果扫码账号发生变化，旧 chat 绑定会被清除，新用户成为 owner。

## 开发与发布

```bash
npm install
npm run typecheck
npm test
npm run build
npm link
```

源码安装：

```bash
git clone https://github.com/YeFeng-Silence/lark-coding-assistant.git
cd lark-coding-assistant
npm install
npm run build
npm link
```

发布前更新 `package.json` 和 `package-lock.json` 的版本号并提交。确认已登录公共 npm registry 后再发布：

```bash
npm whoami --registry=https://registry.npmjs.org
npm publish
```

不要在仓库中保存 npm token；发布身份由开发机或 CI 的 npm 配置提供。
