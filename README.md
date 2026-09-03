# lark-coding-assistant

`lark-coding-assistant` 是一个轻量的本地桥接工具：它把 codex、traex 或 claude 运行在受管 tmux session 中，让本地终端与飞书/Lark PersonalAgent 私聊操作同一个 coding agent 上下文。

远程消息、交互选择、查看输出和恢复现场都通过精确绑定的 tmux pane 完成；任务通知由 agent 原生 `Stop` hook 与终端停止输出状态共同确认。

## 主要能力

- codex、traex 与 claude 可混合运行，默认使用 codex；
- 支持多个命名 session，一个飞书账号可在 `/sessions` 卡片中直接切换或新建；
- 普通飞书消息默认发送到当前 active session；消息被 bridge 接收后会在原消息上显示处理中表情，下一条 bridge 通知发送前或等待满 10 分钟时自动移除；
- 支持 `/tail`、`/status`、`/stop`、远程处理审批与 Question，以及无法识别画面的手动遥控兜底；
- 本地终端保持 attach 时，飞书仍可操作同一个 TUI；
- 首次扫码后保存唯一 owner，后续通常无需绑定码；
- daemon 单实例运行；升级、重启或恢复 daemon 不会停止现有 tmux session；
- 同一个 Agent 原生 session 只允许由一个 LCA session 占用；hook 候选会由当前 pane PID 复核后才绑定或判冲突。

远程审批不按 codex、traex 或 claude 版本号限制。bridge 只有在当前 TUI 被高置信度识别为结构化交互，并且选项、默认光标和提交按键映射完整时才发送飞书交互卡。

## 环境要求

- macOS 或 Linux
- Node.js 20.12+
- tmux
- 至少安装一个 Agent：codex、traex 或 claude（只需安装实际要使用的 Agent）
- 可访问飞书或 Lark Open Platform

### 推荐的 coding agent 版本

以下版本已完成 Stop hook、任务通知、审批、Question、单选/多选和手动遥控回归，建议优先使用：

| Coding agent | 推荐版本 |
| --- | --- |
| codex | `0.148.0` |
| traex | `0.201.5` |
| claude | `2.1.241` |

这些是已验证的推荐版本，不是强制版本锁定。其他版本通常也可以运行；如果新版调整了 TUI 文案或按键交互，结构化卡片可能暂时无法识别，此时仍可通过 `/tail` 和手动遥控模式完成操作。

## 一键安装与初始化

```bash
npm install -g lark-coding-assistant@latest && lca init
```

初始化向导会选择飞书或 Lark、可选配置 workspace，并展示 PersonalAgent 注册二维码。保持命令运行，在有效期内完成扫码、应用选择、权限、事件和卡片回调；终端显示配置已保存即完成。配置保存在 `~/.lark-coding-assistant`，App Secret 仅写入权限为 `0600` 的本机 `secrets.json`。下文统一使用短命令 `lca`。

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

Session 创建和恢复有 30 秒启动事务；超时会清理临时 tmux/state，并返回失败阶段与最近终端输出。Resume Picker 等待选择不计时，提交选择后重新开始 30 秒恢复事务。该限制不影响消息、交互、`status`、`tail`、`attach`、`stop` 或 daemon 管理。

一个 PersonalAgent 私聊同一时刻只连接一个 active session。在飞书发送：

```text
/sessions
```

机器人会发送一张按 codex、traex、claude 分组的交互卡，并显示绝对项目路径。`● 当前` 表示 active session；可直接连接、关闭或新建。新建表单支持从已有 session、最近目录和 workspace 中选项目，也可手动填写 `/绝对路径` 或 `~/路径`。创建成功后自动连接；旧列表仍可用于连接和关闭。也可使用：

```text
/use web
```

切换只改变飞书消息和通知的路由，不会停止其他 session。普通消息、`/tail`、`/status`、审批、`/stop` 和停止输出通知都只作用于 active session。

## Workspace 项目目录

可以配置多个常用 workspace root：

```bash
lca workspace add .
lca workspace add ~/workspace
lca workspace add ~/code/company
lca workspace list
lca workspace remove ~/code/company
```

`add` 和 `remove` 支持相对路径，并按执行命令时的当前目录解析。例如 `lca workspace add .` 会把当前目录保存为绝对路径。

配置修改会在下一次打开飞书“新建 Session”表单时生效，不需要重启 daemon。

飞书新建 Session 会合并存活 session、最近成功目录和 workspace 下一级项目；Git 仓库优先、同一路径去重、最近目录最多保留 30 条。扫描上限为 2 秒或 500 个目录，超限或无权限时仍可使用“手动填写其他路径…”。手动输入支持 `~/...`，启动前会展开校验；所有状态与结果始终显示绝对路径。

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

飞书只提供“新会话”和原生 Resume Picker。Picker 会被解析为卡片，不要求手输历史 ID，也不会进入手动遥控；仅存在未展示候选项时才显示翻页。启动结果、session 列表、状态与失败提示统一显示绝对路径；Picker 失败卡仍提供“新建 Session”和“查看 Sessions”。

## 本地终端与 tmux

本地保持 attach 不影响飞书操作。临时离开 tmux 使用 `Ctrl-b` 后按 `d`，不会停止 Agent 或 daemon；重新进入：

```bash
lca attach default
lca attach web
```

飞书 `/detach` 则会解除私聊绑定并关闭自动重连。

## 飞书/Lark 私聊命令

- `/sessions`：按 agent 分组展示所有仍存活的 session 及其绝对路径，可直接连接、关闭或打开新建表单。
- `/start`：直接打开新建 Session 表单。
- `/start <name> --agent <codex|traex|claude> --cwd <绝对路径或 ~/路径> [--resume]`：用文本命令启动并自动连接新 session；包含空格的路径请加引号。使用 `--resume` 会打开原生 Resume Picker。飞书端不支持“恢复上次”或直接输入历史 Session ID。
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
lca start [--name <name>] [--agent codex|traex|claude] [--cwd <path>] [--resume [session-id]|--resume-last|--resume-all]
lca attach [name]
lca status [name]
lca stop [name]
lca bind-code
lca reset-owner
lca logs
lca logs --lines 300
lca daemon          # 仅启动后台 bridge daemon
lca daemon status
lca daemon stop
lca daemon restart
```

`daemon stop/restart` 只断开或恢复飞书连接，不停止受管 tmux session。顶层 `stop [name]` 才会停止对应 agent 和 tmux session。

电脑休眠或网络暂时断开时，飞书长连接会自动重连；这不会停止 daemon 或受管 tmux session。唤醒后等待连接恢复即可，只有明确执行 `lca daemon stop` 才会停止 daemon。

`lca status` 会先显示 daemon 状态，再用一个表格列出全部 session；session 按 `codex`、`traex`、`claude` 分组排序，每个 session 占一行，当前连接使用 `●` 标记。表格同时显示终端状态、tmux 状态和绝对工作目录。使用 `lca status <name>` 可只查看指定 session；daemon 不可用时仍会读取本地状态，并将无法确认的运行信息明确标出。

## 绑定规则

首次扫码会保存可信 owner，后续通常无需绑定码。仅在飞书执行过 `/detach`、迁移私聊或没有保存 owner 时运行 `lca bind-code`。绑定码 10 分钟有效，只在本地保存 scrypt 哈希：

```text
/attach <一次性绑定码>
```

## 交互卡与消息排队

当 active agent 显示结构化编号选择时，bridge 从终端提取标题、选项、光标、勾选状态和提交方式，归一化为单选、多选或补充输入语义；三个 Agent 共用同一套卡片和 tmux 提交流程。选项只来自当前 TUI，无法完整识别时不会生成操作按钮。

单选直接提交；多选是事务式表单，勾选和补充内容先只保存在飞书，点击“提交答案”后才一次同步到本地。Agent 出现二次确认时，原卡片会刷新为下一步确认。

每次卡片操作都会校验 owner、active session、pane、画面指纹、签名和 nonce。选择画面不因等待时间失效；画面、pane、Agent 或 active session 改变后旧卡立即失效。停止与 session 选择卡使用短时有效期。

## 手动遥控兜底

当 active pane 稳定 3 秒、状态为 `input` 或 `unknown`，但无法生成高置信度操作卡时，会自动发送手动遥控卡；也可使用 `/manual` 主动打开。它支持方向键、Enter、Esc、Tab、Space、Ctrl+C、仅输入、输入并提交和刷新。除刷新外，每次操作都会校验 owner、session、pane 与画面指纹；它不判断按键业务安全性，请先确认画面。退出手动模式只禁用卡片，不停止 Agent。

Agent 正在交互、本地输入框有草稿或画面未知时，普通消息会进入最多 100 条的内存 FIFO；恢复安全输入后顺序发送。daemon 重启、`/detach`、切换或停止 session 时队列清空。

## “等待用户输入”通知

Agent 原生 `Stop` hook 提供候选结论；daemon 仅在 active pane 回到 `idle` 且连续 2.5 秒无新输出后发送通知。多个中间事件会合并，正文始终使用最后一条 `last-assistant-message`；非 active session 不推送。

## 升级与卸载

```bash
npm install -g lark-coding-assistant@latest
lca daemon restart
```

直接执行 `lca start` 也会比较 CLI 与 daemon 版本并优雅更新 daemon，不停止现有 tmux session。

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

daemon 日志、stdout、stderr 与启动崩溃都写入 `logs/assistant.log`。CLI 默认只显示友好错误和下一步建议；需要排查时使用：

```bash
lca daemon status
lca logs
```

需要排查未知异常时，可以只为当前命令开启调试输出：

```bash
LARK_CODING_ASSISTANT_DEBUG=1 lca <command>
```

调试模式会附加原始堆栈，可能含本机路径或环境信息，请勿直接公开。

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

## 常见问题

### 飞书消息进入了错误的 session

发送 `/sessions`，查看 `● 当前` 并点击目标 session。普通消息永远只进入 active session。

### 没收到某个 session 的完成通知

只有 active session 会主动推送。session 必须由当前 CLI 创建，才能注入统一的 `Stop` hook。

### 消息提示已排队

通常是 agent 正在审批、本地输入框已有草稿或画面无法识别。发送 `/tail` 查看当前状态。

### 卡片或按钮显示已失效

Agent、active session、pane、画面或 nonce 已变化。重新发送 `/sessions`，或先用 `/tail` 查看审批/Question 当前画面并等待新卡。

### 关闭本地终端后 session 还在吗

关闭 attach 的终端通常不会停止 tmux，可用 `lca attach <name>` 恢复。电脑关机、tmux server 被终止或 Agent 自身退出后无法继续；daemon 会在下一次轮询移除已退出 session，并切换到其他存活 session。

### 完全重新配置 PersonalAgent

重新运行 `lca init`。如果扫码账号发生变化，旧 chat 绑定会被清除，新用户成为 owner。
