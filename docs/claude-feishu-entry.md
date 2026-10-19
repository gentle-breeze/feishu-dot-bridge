# claude-feishu 用户入口

所有实现均在原 feishu-dot-bridge 仓库。`scripts/claude-approval/claude-feishu` 是 Python 3 可执行脚本，定位同目录 `launch.py`，通过已有 `claude-gptcc` 启动审批会话；不会运行安装/login、修改全局 Claude 配置或启动 Bridge。需要已经运行且绑定本人的审批服务，服务的 `CLAUDE_APPROVAL_DIR` 应为 `$HOME/.claude-feishu-approval`。本次只交付和隔离测试，没有启用生产服务。

## 用户级安装

在需要长期保留的本仓库 checkout 中执行：

```sh
python3 scripts/claude-approval/install.py
# 若 ~/.local/bin 不在 PATH，仅对当前终端设置：
export PATH="$HOME/.local/bin:$PATH"
claude-feishu --plan --model opus --prompt '请先提出计划'
```

安装器创建 `~/.local/bin/claude-feishu` 到仓库脚本的软链接；同一来源重复执行成功。目标已有文件、不同链接（包括失效链接）或 PATH 中已有不同命令时拒绝，不覆盖。不会编辑 `.zshrc`/`.bashrc`，不会安装依赖、写凭据或启动服务。仓库移动后旧链接失效，需本人检查并移除旧链接后在新位置重装。卸载只需本人确认该链接后删除 `~/.local/bin/claude-feishu`，保留审批数据和仓库。

未安装时可直接运行 `python3 /absolute/path/feishu-dot-bridge/scripts/claude-approval/claude-feishu ...`。调用者工作目录、参数内空格、标准输入输出及正常退出码保留；不使用 shell 拼接执行命令。

## 只导入五项模型映射

仅从 `~/.claude/settings.json` 的 `env` 对象导入以下五个**精确键**：

| 用途 | 配置/环境键 |
| --- | --- |
| Opus | `ANTHROPIC_DEFAULT_OPUS_MODEL` |
| Sonnet | `ANTHROPIC_DEFAULT_SONNET_MODEL` |
| Haiku | `ANTHROPIC_DEFAULT_HAIKU_MODEL` |
| Fable | `ANTHROPIC_DEFAULT_FABLE_MODEL` |
| 子代理 | `CLAUDE_CODE_SUBAGENT_MODEL` |

进程已有同名变量始终优先，包括空值；无效空值会报错而不从文件替换。五项都必须有效，避免会话中切换别名或调用子代理后落回未映射的 Claude 模型。文件不存在时可全部由进程环境提供；已有文件无法解析或 env 结构错误时失败关闭。错误仅指出键名，不打印配置内容/模型值。不会导入 model 字段、自定义模型菜单项、凭据、Hook、MCP、插件或其他设置，也不写回原文件。进程本来已有的环境变量保留，不负责清理或认证其内容。

`--model` 接受 opus、sonnet、haiku、fable 、五项**合并后有效值**中的网关模型 ID，或直接 GPT/OpenAI 模型 ID（gpt-*、chatgpt-*、o 系列），例如 `--model gpt-6-astra`。直接 ID 不要求出现在五项映射中，不固定当前模型版本名单；只校验模型 token 格式，原样传给 GPTCC。四个主模型映射需为具体网关 ID，不可递归指向内置别名或 `claude-…`。子代理可指向已映射别名或独立网关 ID。不传 --model 时，使用进程 ANTHROPIC_MODEL，其次 ANTHROPIC_DEFAULT_MODEL，再其次显式 sonnet；同样校验，不读取 settings.model，不覆盖已有模型变量。不支持 default/best 或既未映射又不属于上述直接模型格式的名字。模型 ID 校验不是网关可用性探测。

实现前只读核验发现当前文件只有上述 Haiku 精确键，另外四项缺失；未替用户补写或猜测。真实使用需在调用环境补齐有效映射，或由本人维护原有配置。不要把密钥放进示例或提交。

键名和 CLI 行为参考官方 [模型配置](https://code.claude.com/docs/en/model-config) 与 [CLI 参数](https://code.claude.com/docs/en/cli-reference)（2026-10-19 核对）。`ANTHROPIC_CUSTOM_MODEL_OPTION` 不是 Fable 映射，不从该项猜测。

## 参数和恢复会话

支持 `--plan`、`--prompt TEXT`、`--model MODEL`、`--resume [ID或名称或路径]`、`--continue`、`--session-id UUID`；支持带值参数的 `--name=value` 形式，值保持不变。裸 --resume 打开原生选择器。--resume 与 --continue 互斥；--session-id 仅用于新会话，不与恢复参数组合。prompt 最终位于 Claude 的 `--` 分隔符后，因此 `--prompt=--settings=x` 只是文本。

```sh
claude-feishu --resume '之前的会话名称'
claude-feishu --continue --prompt '继续处理'
claude-feishu --session-id '550e8400-e29b-41d4-a716-446655440000'
```

严格允许列表拒绝其他选项、缩写、短参数组合和 `--` 透传，包括 --permission-mode、--settings、--setting-sources、--mcp-config、-p/--print，以及各种等号形式。该入口不开放 bypass。底层 launch.py 仍有历史显式 bypass 开关，但不能通过 claude-feishu 传入。

恢复的是 Claude 对话，不是审批租约：每次启动创建新的随机审批 ID，旧卡片不能复用。临时私有身份文件由 SessionStart 固定实际 CLI session_id，后续 Hook 必须匹配，才映射到新的审批 ID。未收到 SessionStart、ID 错误、试图换绑、临时文件丢失均不给批准。文件在退出时删除。新会话可预绑定指定 UUID。运行中通过原生 /resume 切换到另一个会话会触发身份不匹配，应退出并从入口重新恢复。生命周期、断线和超时策略仍见 [审批说明](claude-remote-approval.md)。

## 验证与边界

```sh
python3 test/claude_entry_test.py -v
npm run build
node --test dist/test/claude-entry.test.js dist/test/claude-approval.test.js dist/test/claude-card-callbacks.test.js
```

测试仅使用临时 HOME/PATH、假包装器、隔离 Unix socket，不读取真实用户配置，不启动真实 Claude/生产 Bridge、不发送卡片。覆盖五键读取、环境优先、缺失/畸形配置、缺失启动器、cwd/空格/退出码、恢复会话绑定、新审批 ID、禁用参数和重复安装/冲突。Linux 完整 CI 与 macOS 扩展 CI 均包含入口测试。

尚未验证真实 Claude 恢复流程及 SessionStart 在当前安装版本的实际调用顺序；缺失 Hook 时服务端不会接受审批，但无法承诺所有原生 Hook 失败兜底都阻止工具执行。此功能依然只覆盖已支持的审批 Hook；登录、原生选择器、所有 TUI 和任意 CLI 交互不在飞书卡片覆盖范围。
