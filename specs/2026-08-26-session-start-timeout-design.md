# Session 启动事务与超时设计

## 背景

当前 CLI 对所有 daemon 请求统一使用 5 秒超时。Session 启动需要经过状态同步、Agent 版本探测、tmux 创建、元数据写入和启动确认，合法耗时可能超过 5 秒。客户端会先报“bridge daemon 未及时响应”，而 daemon 可能仍在后台继续执行或回滚，导致用户无法判断最终结果，日志也缺少本地启动失败的完整上下文。

## 目标

- 本地和飞书共享同一套可靠的 session 启动事务。
- 启动或恢复必须在 30 秒内成功或明确失败。
- 超时后停止底层工作、关闭临时 tmux 并回滚所有临时状态，不留下后台任务。
- 同名 session 正在启动时，后续请求明确返回“正在启动”。
- 本地和飞书都展示可行动、可诊断的最终错误。
- 不改变普通消息、审批、Question、手动遥控和完成通知机制。

## 超时边界

30 秒硬超时仅约束创建或恢复 session 的启动阶段：

- 本地 `lca start`；
- 飞书“新建 Session”；
- 新会话启动；
- Resume Picker 启动到选择器成功展示；
- 用户选择历史会话后，Agent 恢复到可用状态。

Resume Picker 卡片展示后等待用户选择的时间不计入 30 秒。用户提交选择时开始一个新的 30 秒恢复事务。`status`、`sessions`、`tail`、`attach`、`use`、消息发送、交互处理、`stop` 和 daemon 管理沿用各自现有行为。

## 方案选择

采用 daemon 内部启动事务协调器。仅延长客户端超时无法保证 daemon 停止后台工作；持久化任务队列则超出本需求，且会增加恢复半完成启动的复杂度。

## 架构

新增 `SessionStartCoordinator`，以 session 名为互斥键管理内存中的启动事务。CLI 与飞书入口均通过该协调器调用现有启动能力。

每个事务包含：

- 唯一 `startId`；
- session、Agent、绝对工作目录、resume 模式与请求来源；
- 30 秒 deadline 和 `AbortSignal`；
- 当前阶段、开始时间与阶段耗时；
- 已创建的 tmux/session 临时资源，用于幂等清理。

同名事务存在时返回 `SESSION_STARTING`。不同名称允许并行启动。

## 启动流程

1. 校验参数并原子占用 session 名。
2. 写入带 `startId` 的结构化请求日志。
3. 在统一 deadline 下执行：状态同步、Agent 版本探测、tmux 创建、元数据写入和 Agent 启动确认。
4. 每个外部命令使用剩余时间作为自身超时，并响应取消信号。
5. 启动成功后提交最终 state、解除占用并返回 session。
6. 明确失败、异常或总超时均进入同一个清理路径。
7. 清理完成后返回最终结果；清理自身的异常只写日志，不覆盖原始错误。

Resume Picker 分为两个事务：第一个事务以选择器成功展示为完成；用户提交选择后启动新的恢复事务。

## 状态与清理

启动事务不写入长期 state。必须提前写 state 的现有步骤改为显式的临时资源跟踪，只有启动成功才对外提交可用 session。若实现约束要求启动中短暂写 state，则该状态必须带内部启动标记，并保证任何读取路径不会将其展示为可用 session。

清理函数可重复调用，并负责：

- 终止仍运行的外部子进程；
- 关闭本次创建的 tmux session；
- 移除临时 session state；
- 清除 pending agent claim、resume picker、启动冲突与相关内存状态；
- 释放 session 名互斥占用。

daemon 意外退出后，现有 reconcile 机制负责清理未登记完成的临时 tmux；元数据需能区分已提交 session 与启动中资源。

## 错误模型与用户反馈

新增错误码：

- `SESSION_STARTING`：同名 session 已在启动；
- `SESSION_START_TIMEOUT`：总启动超过 30 秒并已清理；
- `SESSION_START_TIMEOUT` 的上下文始终记录具体失败阶段，例如 Agent 探测、tmux 创建或启动确认。

错误上下文包含 session、Agent、绝对工作目录、失败阶段、耗时、终端尾部和 `startId`。敏感信息与控制字符在展示前沿用现有安全清洗逻辑。

本地 CLI 对 start 使用 35 秒请求等待时间，以接收 daemon 在 30 秒 deadline 后完成清理所返回的最终错误。它不再把启动超时建议为重启 daemon。

飞书创建入口先确认操作已受理。失败时将处理中卡片更新为持久失败卡片，展示 session、Agent、绝对路径、明确结论和可用的原始终端尾部，并提供“新建 Session”“查看 Sessions”按钮。

## 可观测性

所有启动日志使用统一字段：`startId`、`source`、`session`、`agent`、`cwd`、`resume`、`stage` 和 `elapsedMs`。至少记录：

- `session start requested`；
- 每个阶段完成或失败；
- `session start succeeded`；
- `session start failed`；
- `session start timed out`；
- 清理结果。

本地和飞书入口不再各自维护不同的失败日志逻辑。

## 测试策略

单元测试覆盖：

- 正常成功；
- 各启动阶段失败；
- 30 秒硬超时及底层命令取消；
- 同名并发返回 `SESSION_STARTING`；
- 不同名并行；
- 清理函数重复执行；
- 清理失败不覆盖原始错误。

daemon 集成测试覆盖：

- 超时后 state 和 tmux 均不存在；
- CLI 收到清理后的 `SESSION_START_TIMEOUT`，而非通用请求超时；
- 超时后同名 session 可以重新启动；
- daemon 仍可响应其他控制请求。

飞书卡片测试覆盖失败卡片更新、绝对路径、终端尾部和恢复按钮。最后回归 codex、traex、claude 的新会话与 Resume Picker 流程，以及现有 224 项测试。

## 验收标准

- 任何 start/恢复操作最多运行 30 秒。
- 超时后没有对应 tmux、state、pending claim 或后台子进程。
- 同名并发不会创建重复 session。
- 本地和飞书能看到同一原始失败结论。
- 失败日志可通过 `startId` 完整串联。
- 非启动类 daemon 命令不受 30 秒策略影响。
