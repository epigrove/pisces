# dsh-koi-chat

中文 | [English](./README.md)

提供 agent 与运维方、Pisces 主人之间可校验签名的追加式对话通道，并附带每日提案流程。

## 它做什么

- `koi`、`ashu`、`master` 共用同一个 `chat.jsonl`，各方只追加自己的消息，不回头改写历史。
- 按 HMAC-SHA256 校验入站行；未签名或签名不符时明确标记，而不是静默当成可信消息。
- 只在专用 `session-chat-*` 会话中以运行时上下文快照注入未读消息，并受可配置批次上限控制。
- 成功 `turn/end` 后才提交各来源游标和 seen id，二者共用一个原子已读快照。
- 新消息到达时用文件监听加分来源轮询，通过 `agent.followup()` 唤醒 agent。
- 暴露 `talk_to_sister`，对 `request` 消息限制未回条数，并明确拒收超过 4,000 字的消息。
- 每天从记忆和近期聊天生成提案，去掉重复或截断内容后，经同一对话通道发回。

## 设计思路

- **单写者追加语义避免合并冲突。** `chat.jsonl` 是跨进程共享契约；每个写入方只追加自己的来源，纠正也写新消息引用旧消息。共享可变文件需要锁，仍可能留下含义不明的半更新。
- **已读状态在成功交付后提交。** 提示词组装可能失败或取消。把游标和 seen 放在一个快照里，并且只在成功回合结束时提交，失败后会重放，但不会漏消息。
- **签名提高冒充成本，但不提供用户隔离。** 同 uid 进程仍能读密钥。它能挡住随手写 `from: ashu` 的伪造，并记录坏签名或未签名来源；真正隔离要靠独立用户或 socket 权限。
- **唤醒触发串行化并按来源路由。** 文件监听、运维方轮询和更快的主人面板轮询共享同一轮 in-flight wake。两条来源使用不同的 `session-chat-*` 会话，避免历史混淆，并用 `to` 正确路由回复。

## 配置

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `dir` | 解析后的 KOI 数据目录 | chat、密钥、已读状态、提案和覆盖配置的基础目录。 |
| `injectLimit` | 初始 `6`，随后读面板 `defaults.injectLimit` | 每次组装最多注入多少条未读消息。 |
| `maxOutstanding` | `3` | agent 最多连续发多少条尚未回复的 `request`。 |
| `wakeMinutes` | 初始 `5`，随后读面板 `defaults.wakeMinutes` | 运维方通道轮询分钟数。 |
| `masterPollSeconds` | `5` | 主人面板轮询秒数；设为 `0` 可关闭。 |
| `iterateHour` | `4` | 每日提案生成的本地小时。 |
| `iterateMinute` | `0` | 每日提案生成的本地分钟。 |
| `iterateChatDays` | `3` | 提案用作上下文的近期短期记忆文件天数。 |
| `iterateChatLimit` | `60` | 提案提示词最多考虑多少条近期聊天。 |
| `iterateProvider` | 空 | 提案显式 provider。 |
| `iterateModel` | 空 | 提案显式 model。 |
| `iterateCapabilities` | 空 | 提供给提案模型的能力说明。 |
| `memoryFile` | iterate 默认 `<KOI_HOME>/.koi/memory.md` | 作为兜底上下文的旧记忆路径。 |
| `shortDir` | iterate 默认 `<KOI_HOME>/.koi/short` | 提案使用的近期聊天来源。 |
| `KOI_HOME` | 用户主目录 | 共享数据根兜底。 |
| `MODEL_PROVIDER`, `MODEL_NAME` | 空 | 没有显式、面板或活会话路由时使用的最后兜底模型。 |
| `DSH_HOME` | `~/.dsh` | 定位人设 profile 的根目录。 |
| `QQBOT_PROFILE` | `koi` | 读取人设文本时使用的 profile 名。 |
| `QQBOT_ITERATE_NOW` | 未设置 | 设为 `1` 时启动后立即生成一次提案。 |
| `QQBOT_ASK` | 未设置 | 启动时按人设与记忆回答问题，再经 chat 发出。 |

## 接口

| 名称 | 类型 | 作用 |
| --- | --- | --- |
| `koi-chat` | 插件 id | 包导出的挂载名。 |
| `tools` | 注入服务 | `talk_to_sister` 注册所必需。 |
| `system-prompt/assemble` | 事件订阅 | 向专用 chat 会话注入未读消息。 |
| `session/event` 的 turn end | 事件订阅 | 只在成功结束时提交已读状态。 |
| `koi:chat` | 运行时上下文快照 | 来源标签、未读消息、可信度标记和回复提示。 |
| `talk_to_sister` | 工具 | 向共享通道追加 `chat` 或 `request` 消息。 |
| 文件监听、运维方轮询、主人轮询 | 定时器 | 触发串行化的 `agent.followup()` 唤醒。 |
| 每日提案定时器 | effect timer | 在配置的本地时间生成并发送一次提案。 |

## 验证

在仓库根目录运行：

```bash
for f in plugins/dsh-koi-chat/test-*.mjs; do node "$f" || exit 1; done
```

五个测试文件逐条打印 `✅` 或 `❌`，结束时输出 `N 通过 / 0 失败`。全部通过时退出码为 `0`。

## 说明 / 限制

- ops 注入只允许 `session-chat-` 开头的会话；QQ、普通 agent 和无法识别的会话拿不到 ops 上下文，也不会推进其游标。
- HMAC 密钥防的是随手伪造，不是操作系统同用户下的恶意进程。
- 已读快照保存失败时会刻意在后续回合重放消息，而不是漏掉消息。
- `talk_to_sister` 拒收空消息和超过 4,000 字的消息，不会静默截断。
- `chat.jsonl` 不可读时会明确报告，不会把“读失败”当成空通道，也不会推进注入或回复发送。
- LLM 不是硬注入依赖；缺少 LLM 配置只会禁用提案分支，对话通道仍可用。
- 提案分支需要完整 provider/model 路由；缺失时记录跳过，不构造非法请求。
- 本插件读取并校验签名，但不替外部写入方生成签名；写入方必须使用同一套 HMAC 格式。
