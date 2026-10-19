# Claude 审批交互卡片

本版本将本人私聊中复制 `/claude JSON` 改为飞书卡片直接操作。普通权限只有“允许本次 / 拒绝”；计划只有“批准计划（仅本次）/ 填写意见后退回”；问题使用单选、多选及自由输入，一个表单统一提交全部问题。填写自由文本时优先采用该内容，每项最多 1000 字符。卡片明确显示项目目录、完整会话/请求 ID、工具摘要和待审输入。缺少 Hook cwd 时明确显示“未提供项目目录”。

卡片回调不会增加 session bypass。即使旧启动器显式提供 bypass 可用性，卡片也没有 bypass 动作，伪造该动作被拒绝。旧 `/claude ` 文本被消费但不能审批，也不会进入普通 dot 聊天。mock 终端的 JSON 输入仍是本地开发控制器，不是飞书用户操作方式。

## 官方协议与 SDK 核验（2026-10-19）

已读取官方网页正文并核对当前依赖 `@larksuiteoapi/node-sdk 1.74.0` 的实现：

* [处理卡片回调](https://open.feishu.cn/document/uAjLw4CM/ukzMukzMukzM/feishu-cards/handle-card-callbacks)：当前官方支持企业自建应用长连接接收回调，也支持 Webhook；推荐新版 `card.action.trigger`，要求快速响应。不是 `card.action.trigger_v1`。
* [JSON 2.0 表单容器](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/containers/form-container)：`form`、`name`、`form_action_type: submit`、按钮 `behaviors: [{type: callback,value: ...}]`；数据在 `action.form_value` 中一次回传。
* [按钮](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/button)：按钮可直接放在根节点，callback value 为对象。
* [多选回传格式](https://open.feishu.cn/document/feishu-cards/card-components/interactive-components/multi-select-dropdown-menu)：多选 form_value 是 option value 字符串数组；按服务端原始问题/选项映射，不能提交未知标签或重复选项。
* [输入框](https://open.feishu.cn/document/feishu-cards/card-json-v2-components/interactive-components/input)：使用多行输入，max_length 上限为 1000，不使用未经支持的 4000。
* [更新消息卡片 API](https://open.feishu.cn/document/uAjLw4CM/ukTMukTMukTM/reference/im-v1/message/patch)：复用 Bridge 的 `LarkSender.patchCard` 更新已发送消息。

SDK 的 `RequestHandle.parse` 将 v2 header/event 展平；`EventDispatcher.invoke` 返回 handler 结果；`WSClient.handleEventData` 将结果编码回响应。隔离测试使用真实 SDK dispatcher 验证该路径，网络连接本身为模拟。SDK README 仍有“长连接不支持回调订阅”的旧说明，与当前官方回调指南及 SDK 实现不一致；不据该旧句否认当前支持，也不据单元测试宣称生产订阅已可用。

## 接入与授权边界

仍仅在显式 `CLAUDE_APPROVAL_DIR` 开启时注册卡片 handler，复用已认证的现有单应用个人 WebSocket，不起第二个连接、不增公开 HTTP callback 端点。Webhook 是官方可选协议，但本项目本轮未实现独立 Webhook 卡片入口。普通 `im.message.receive_v1` 继续走原 Bridge 路由；`card.action.trigger` 单独处理，不写普通 dot inbox。其它 kind 的卡片不被审批扩展接管。

上线前需在既有应用后台确认新版卡片回传交互订阅、长连接回调方式，以及已有发送/更新卡片权限。**代码不会配置这些选项；本轮没有部署、重启、改变权限/应用配置或发送真实测试卡片。** 现有开关配置、代理、凭据和绑定不变。生产实际是否拥有足够权限仍需授权后核验，不创建新凭据。

只信任 SDK 已认证连接送入的回调；`receiveCard` 不是任意 JSON 的身份认证接口。服务再核验 app、应用/操作者 tenant、本人 open_id、当前有效绑定、私聊 chat ID、原始发送 message ID、request/session UUID、动作及按钮名、回调时间和请求截止时间。转发卡、旧卡、换绑、跨会话、重放、未知动作与缺少表单项均不能批准。判定与消费沿用 SQLite 原子事务；拒绝可覆盖尚未消费的允许，已消费批准不能撤销。

## 更新与恢复

发送成功后持久记录原 message ID、绑定快照、项目/会话/工具元数据。回调原子记录决定并返回 toast，不等待飞书 API；后台串行更新原卡为“已批准 / 已拒绝 / 已过期”，移除全部操作控件。没有点击时的超时、会话取消和服务重启也进入过期更新。状态表示审批决定，不等于工具执行成功。

更新失败保留队列，每 5 秒再试；重启继续更新旧卡的失效状态。不会因更新失败重新发卡或重新允许工具。更新进行中发生新的拒绝/失效时，后续一轮按最新状态纠正；短暂 UI 滞后不影响服务端拒绝旧请求。后台只有同一个绑定仍有效时才更新旧消息，换绑后不触达旧聊天。飞书持续不可达、消息已删除、API 更新时限已过时不能保证 UI 最终变化；旧卡服务端校验仍失败关闭。发送成功但回执丢失时没有可信 message ID，不接收该卡审批，也不自动重发。

关闭时等待已有发送/更新完成，持久数据保留；服务重启取消旧 session。回滚应停新扩展、移除开关并恢复原启动方式，不删除原 Bridge 数据库。新增 `approval_cards` 表通过 CREATE TABLE IF NOT EXISTS 增量创建，不修改原请求表或 Bridge 主库。记录只用于关联和恢复，日志不含表单答案、计划正文、身份或秘密；卡片本身的待审输入仍可能敏感，应仅在本人私聊使用。

## 验证与限制

```sh
npm run build
node --test dist/test/claude-approval.test.js dist/test/claude-card-callbacks.test.js dist/test/websocket.test.js dist/test/request-diagnostics.test.js
```

新增测试覆盖：权限按钮和状态卡；多问题/单多选/自由输入映射；计划意见及拒绝优先；错误身份/租户/聊天/原消息/请求/会话/按钮/过期事件/bypass；跨请求消息去重；无人点击的到期更新；patch 失败重试；重启恢复与换绑隔离；工具文本转义；真实 SDK dispatcher 的回调响应与正常聊天隔离。既有 Python Hook→Unix broker→模拟回调链路和启动器测试继续运行。

没有真实飞书发送/点击，也没有新版本真实 Claude 运行。尚未实测飞书桌面/移动端外观、生产应用回调订阅/网络时延、真实 API 更新、真实回调重推，以及 Claude 原生失败兜底。Hook 被 SIGKILL 或硬超时不能靠本功能保证所有原生行为，仍依赖平台隔离与 Claude 策略。
