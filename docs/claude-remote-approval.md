# Claude Code 本人飞书远程审批

本功能为显式启用的 Bridge 扩展，提供 Claude Code CLI 的 PermissionRequest、AskUserQuestion（PreToolUse）和 ExitPlanMode 交互。默认不启用生产接入，不创建凭据、不修改全局 Claude 配置、不启动第二个飞书 WebSocket 消费者、不修改订阅或定时任务。

## 启动与本地模拟

要求 Node >=24（内置 node:sqlite）、Python 3、现有 claude-gptcc 和已授权代理。先在仓库执行 `npm ci && npm run build`。本次开发复用了原仓库 node_modules 的只读链接；正常新环境应使用 npm ci。

终端一（工作目录为仓库）：

```sh
node dist/scripts/claude-approval/mock.js /tmp/my-private-approval
```

终端二：

```sh
python3 scripts/claude-approval/launch.py --state-dir /tmp/my-private-approval --prompt '请先提出计划，并询问我一个选择问题'
```

mock 会输出卡片和 request/session UUID。把卡片中的 JSON 对象（不带 `/claude ` 前缀）粘贴到 mock 终端 stdin，即模拟用户回答。这不是实际飞书认证或投递。

正常模式显式传 `--permission-mode manual`，防止现有包装器自行添加默认 bypass。`--plan` 从计划模式开始。入口只接受这些明确参数和 prompt，不支持注入其他 CLI 权限参数、恢复旧会话或任意 executable。

可选会话模式：

```sh
python3 scripts/claude-approval/launch.py --state-dir /tmp/my-private-approval --offer-session-bypass --prompt '先规划，等待我批准'
```

该选项从 plan 开始，同时传 `--allow-dangerously-skip-permissions`。卡片提供 `action=bypass` 的文字说明，用户必须明确回复该动作。`action=allow` 仍只批准计划。只有 ExitPlanMode、输入 permission_mode=plan、该会话显式启用三者同时满足，才返回 `updatedPermissions: [{type:'setMode',mode:'bypassPermissions',destination:'session'}]`。原生启动风险确认留给用户在本机处理，不自动输入确认。退出会话后请重新启动；不使用 resume。平台/组织审批保持适用，本功能无法替代它们。

启动器仅写临时单次 settings，用 `--setting-sources ''` 不加载个人/项目 settings，避免已有 allow Hook 冲突；不写原有配置、不复制凭据。原有组织策略仍由 Claude 执行。若项目依赖额外 settings/MCP，应先审阅独立配置，不直接放开参数透传。

## 接入现有 Bridge（待确认后部署）

已提供默认关闭的生产入口：现有个人模式 Bridge 配置额外设置 `CLAUDE_APPROVAL_DIR=/absolute/private/state` 后，按原有入口 `node dist/src/main.js` 启动。仅支持已配置且独占的个人 WebSocket ingress；未绑定本人时拒绝启动扩展。该环境变量未设置时，原有行为保持不变。这里只交付代码，未修改生产环境变量或运行服务。

`main.ts` 已接线本人回复路由、sender、绑定读取、WS 断线/恢复、关闭清理。`/claude ` 命令由扩展消费，不再流入 dot。当前状态反馈在调用返回值中，卡片不自动更新，用户应以 CLI 继续/拒绝为最终结果。Webhook 宿主接入需另行使用下述 API，不属于当前默认生产入口。

`src/claude-approval/host.ts` 导出 `startBoundApprovals`。宿主传现有 sender、owner 和读取**当前有效 Binding**的函数：

```ts
const approvals = await startBoundApprovals({
  directory: '/private/path/claude-approval',
  sender: existingSender,
  owner: existingOwner,
  binding: () => readCurrentPersonalBinding(),
  ttlMs: 120000,
});
// 在现有已认证 ingress 完成 decodeFeishu/decodeFeishuWebSocket 后，
// 在普通 dot 转发之前调用。解码器已经拒绝群聊和非用户消息。
const result = approvals.receiveAuthenticated(message);
if (result !== undefined) {
  // 此消息归审批扩展所有；不要再次作为普通 dot 输入转发。
  // 可将 accepted / expired / invalid_reply 等状态作为本人私聊反馈。
  return;
}
// 生命周期必须全部接线：
// WS reconnecting/error 或 webhook transport 故障 => approvals.disconnected()
// 确认恢复连接 => approvals.reconnected()（旧会话仍然失效）
// bind/unbind/change => approvals.bindingChanged()
// host shutdown => await approvals.close()
```

该模块没有公开接收任意身份 JSON 的 HTTP API。必须使用已有 Bridge 的签名/加密校验或官方认证 WebSocket dispatcher；`receiveAuthenticated` 不是认证机制本身。绑定固定为扩展启动时的 owner/app/tenant/openId/chatId/bindingId；绑定改变要关闭并重建扩展。定期绑定检查也会取消会话。

当前交互形式为飞书卡片展示 + 本人私聊完整命令回复；**没有交互按钮回调端点**，不需要新增卡片 action callback 权限。多问题一次完整提交，防止部分答案与另一次请求混合。单选或自由回答用字符串，多选可用标签数组（转成实测官方逗号分隔格式）。拒绝可附 feedback：

```text
/claude {"request":"卡片完整UUID","session":"卡片完整UUID","action":"deny","feedback":"请先补充验证步骤"}
```

生产需要现有应用机器人发送消息/卡片能力、接收本人私聊消息事件及当前个人绑定。配置样例位于 `examples/claude-approval/config.example.json`，是宿主配置清单，**不是自动加载的生产配置**；实际内置开关是 CLAUDE_APPROVAL_DIR。不需要提供或新增秘密。宿主接线尚未启用。main.ts 的可选扩展接线与诊断分支存在文件重叠，需审阅后整合；feishu-websocket.ts 与诊断模块未修改。

## 状态、安全与恢复

* SQLite 原子决定/消费。request UUID、session UUID、工具调用 ID/内容指纹、消息 ID 共同防重放。相同 Hook 重试被拒绝，不重新询问；session UUID 从不复活。
* 拒绝可覆盖尚未被 Hook 消费的允许；已消费的批准不能撤回。先到拒绝不能被允许覆盖。
* 默认等待 120 秒，最大 240 秒；Hook 本地等待上限 245 秒，Claude Hook timeout 260 秒。投递失败、格式损坏、未知 session、超时都不给 allow。超过卡片安全大小直接失败，不截断后批准。
* 私有 Unix socket 位于 owner-only 0700 目录；不监听 TCP。锁文件防止多个 broker 启动并清空彼此状态。同一 macOS 用户的进程属于信任边界，不防御已控制该用户的恶意程序。
* 启动器每 2 秒续租；15 秒失联后 session 失效。服务重启取消所有旧会话和未完成请求，断线取消会话；启动器健康检查失败终止当前 Claude 子进程。重新连接后必须重新启动 CLI，旧卡片不能使用。
* 日志只有时间、固定事件名和 request UUID，不写工具参数、计划、回答、身份或秘密。待审参数/回答暂存私有 DB，完成/取消清空逻辑字段；SQLite/WAL/备份仍可能保留历史页，不宣称安全擦除。飞书卡片本身含待审输入（可能有业务敏感内容）；仅在本人绑定私聊使用，用户应审阅再批准。
* Hook 进程被 SIGKILL、Claude 自身 Hook 硬超时、其他版本原生 fallback 行为不能由 JSON Hook 保证拒绝；启动器 watchdog 缩小失联窗口，但不宣称所有故障原子阻断。需要绝对强制隔离的任务仍依赖操作系统/平台沙箱与组织策略。

异常恢复：停止本功能 CLI 与 broker，确认旧 broker PID 已退出，再手动移除**仅本功能目录**的 `server.lock`；保留 DB，可审计恢复，重启会自动失效旧请求。不要删除活服务锁或复用旧 session；不要重启生产 Bridge 作为一般排障步骤。若 DB 损坏，保留原件，将本扩展改到新的私有状态目录，重新启动新 CLI。关闭扩展后临时 settings 自动清理，原全局 Claude settings 未变化。

## 验证范围与上线前最小测试

下午已有证据来自 Claude Code 2.1.236、gptcc 2.5.3、现有 127.0.0.1:52532 代理：核心 26 断言、bypass 18 断言。已读 REPORT、verification、原生 transcript 和 hook/queue 测试；ExitPlanMode allow 必须带原始 updatedInput，不能只返回 behavior=allow。本实现沿用该实测格式。下午证据路径 `/tmp/claude-ask-hook-test-20261018/{full,bypass}`；未复制原始用户 transcript/凭据入 Git。

本项目测试：

```sh
npm run build
node --test dist/test/claude-approval.test.js
npm test
```

测试包含 Python Hook→Unix broker→模拟飞书发送/本人回复→Hook JSON、计划原始输入、多问题、身份/消息去重、重启取消、断线、超时与故障。没有把模拟通过说成真实飞书或新版本 Claude 实测通过；本轮未重跑真实 Claude 业务流程。

真实测试前需确认：现有应用权限与绑定；宿主接线和断线/绑定生命周期；可安排的部署窗口。然后仅在新隔离会话：1）发一张无秘密卡片并本人拒绝；2）隔离目录无害写入分别允许/拒绝/超时；3）三种提问；4）计划允许和反馈拒绝；5）重复/迟到/错误身份拒绝；6）broker 重启及飞书断线；7）如确需 bypass，另开显式启用会话批准固定无害计划。保留脱敏证据，再决定启用生产集成。这里没有自动发送测试卡片或部署。

仅支持上述 Hook 交互。登录、原生风险页、任意终端 TUI、所有 CLI 弹窗、非交互 `-p`、所有模型/版本/管理策略不属于已验证支持范围。

## 本次交付检查（2026-10-18）

* TypeScript build、Python syntax、git diff whitespace 检查通过。
* 审批专用 13 组测试全部通过，包含模拟完整链路、失败关闭、租约、双实例锁、宿主断线/绑定变更，以及使用假包装器验证 launcher 参数。没有调用真实 Claude 或飞书。
* 完整回归首次执行 511 项：442 pass、58 skip、11 fail。11 项均为原有 macOS 图片启动/解码测试；补建 native 执行器并仅给测试进程设置已有 `FEISHU_MACOS_IMAGE_POLICY=resource-limits-only` 后，对应 73 项复测为 71 pass、2 fail。剩余两项 cloud-runtime 图片启动测试自行构造白名单环境，未传入该 macOS 策略；以 Git 基线 main 的独立编译副本运行也得到相同 2 fail（5 项中 3 pass）。未修改图片策略源码/生产环境，未把整套回归宣称为全绿。
* 诊断分支不合并。本分支仅在 main.ts 加默认关闭的入口/生命周期接线（18 行增加、3 行删除），其余为本功能新增文件。整合诊断分支时需审阅 main.ts。

本机测试日志：`/tmp/claude-approval-tests.log`、`/tmp/claude-approval-full-test.log`、`/tmp/claude-approval-regression-policy-retest.log`、`/tmp/claude-approval-baseline-cloud.log`。日志不是生产验证。
