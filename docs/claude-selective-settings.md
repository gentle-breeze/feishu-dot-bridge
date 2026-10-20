# Claude 单次选择性 settings

`claude-feishu` 和底层 `launch.py` 在启动前生成经过筛选的单次 settings，仍使用 `--setting-sources ''`，不让原始配置再次混入。不会修改原 settings，不启动/配置 Bridge，也不修改 webhook、代理、订阅或实际会话权限。

## 来源及合并

读取顺序为用户 `~/.claude/settings.json`、当前工作目录 `.claude/settings.json`、当前工作目录 `.claude/settings.local.json`，以及 Git 主 checkout 根目录的 `.claude/settings.local.json`（若位置不同）。worktree 的主 checkout 通过 `.git` 和 `commondir` 定位。普通偏好由后者覆盖前者；deny/ask 及沙箱拒绝列表去重累积，限制性布尔值不被较弱来源取消。该实现面向已有 2.1.236；不是完整替代 Claude 的配置解析器。自定义 `CLAUDE_CONFIG_DIR`、无法解析的 worktree 元数据会拒绝启动，避免读错配置来源。

不导入项目中的可执行配置，避免把项目命令提升为 CLI settings 权限。组织策略仍由 Claude 原生执行，不读取、删除或覆盖组织策略。若普通来源设置 `disableAllHooks` 或 `allowManagedHooksOnly`，启动器报冲突并退出，不擅自取消该限制。CLI 原生组织限制仍可能阻止 Hook，需在实际集成验证时确认，不能仅据模拟测试承诺全面拦截。

在临时 settings 旁写入权限为 0600 的 `settings-sources.json`，记录来源路径、文件 SHA256、保留字段名和合并规则，不含原配置值或凭据。随临时目录一起清理；不写入 Bridge 日志。配置是启动时快照，运行中不跟随原文件变化；变更后需新开会话。

## 保留范围

- 普通偏好：`theme`、`language`、`outputStyle`、`spinnerTipsEnabled`、`spinnerVerbs`、`showTurnDuration`、`terminalProgressBarEnabled`，按类型校验。自定义输出样式的插件不会因此启用。
- 用户 `statusLine`：只接受已审阅的 `/opt/homebrew/bin/node` 加 `~/Documents/claude-hud/dist/index.js` 命令，核对代码中固定的入口文件 SHA256；可保留非负整数 `padding`。未知命令、入口文件变动或未知字段拒绝启动，不扩大为任意 shell 命令白名单。
- HUD 活动 Hook：只接受用户设置中已审阅的同一 Node 加 `~/Documents/claude-hud/dist/activity-hook.js` 命令及固定文件 SHA256。覆盖已核验的九个事件，按事件、matcher 和命令参数去重；重建为 2 秒同步观察 Hook，不导入其他执行属性。审批 Hook 单独追加，保留 260 秒超时。未识别 Hook 不导入。此处验证已审阅入口文件；不宣称隔离同一 OS 用户修改 HUD 依赖的能力。
- `permissions.deny`、`permissions.ask`；`disableBypassPermissionsMode: disable`、`disableAutoMode: disable`、`blockReadsOutsideWorkingDirectories: true`。不会导入 allow、默认模式或额外目录；未知权限字段报错，避免丢失未知限制。工具规则保持原字符串和启动 cwd。
- 沙箱：`enabled: true`、`failIfUnavailable: true`，关闭自动批准/逃逸/弱化隔离的 false 值；文件 `denyRead`/`denyWrite` 和网络 `deniedDomains`。用户配置的相对沙箱路径锚定用户 `.claude` 目录，项目/local 的相对路径锚定启动 cwd，`~/` 展开为用户 home。拒绝列表累积。只要输出沙箱配置，就明确设置 `autoAllowBashIfSandboxed: false`。

## 继续隔离

其他审批决定 Hook、permissions.allow/defaultMode/additionalDirectories、插件、marketplace、MCP、凭据辅助命令和非白名单 env 不导入。沙箱的 `excludedCommands`、`ignoreViolations`、allowRead/allowWrite、allowedDomains、Unix socket/Mach 放行和代理端口也不导入：它们是放宽访问的例外，移除可能使原任务更受限，而不是自动恢复例外。未知沙箱字段（例如尚未核验的新版本凭据隔离字段）会阻止启动，不能静默省略。

`skipDangerousModePermissionPrompt` 始终在临时配置中置为 false。默认 plan 与可选 bypass 入口不变，只有本人卡片选择才请求 session 更新；原有限制仍可能阻止更新。模型继续只导入原五键，不新增 settings.model 或其他模型配置来源。保留原进程环境和现有 GPTCC 路由约定，不将任意 settings.env 合入子进程；三个 `CLAUDE_APPROVAL_*` 身份/socket 变量由 launcher 最后设置。该机制不是对已被外部修改的进程环境或同一用户脚本的安全沙箱。

## 验证和恢复

```sh
python3 test/claude_settings_test.py -v
npm run build
node --test dist/test/claude-entry.test.js dist/test/claude-approval.test.js dist/test/claude-card-callbacks.test.js
```

测试使用临时 HOME、假包装器和模拟服务，覆盖来源优先级、限制累积、沙箱路径、原文件不变、HUD 去重、未知命令隔离、坏配置在启动前拒绝，以及原审批超时/断线/会话错配失败关闭。真实 HUD 命令、真实 Claude 与飞书均未执行。

HUD 更新后指纹不匹配时，需要重新审阅并更新代码中的指纹，不能自动信任新文件。错误仅报告来源类别与字段，不输出配置值。实际入口目前在工具 shell 的 PATH 中未安装，仓库入口为 `scripts/claude-approval/claude-feishu`；本次不会安装或替换用户终端入口。后续真实验证需先确认用户实际入口版本，再验证底栏、活动 Hook 和限制是否由原生 Claude 正确执行。
