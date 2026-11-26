# dsh-koi-audit

中文 | [English](./README.md)

以只追加流水记录外发与引号核验证据，不拦截消息。

## 它做什么

- 订阅 `dsh-koi-gate` 的真实发送回执，记录平台是否接受了一次发送。
- 按 session、turn、step 把 `assistant/message` 候选和回执配对；关联字段不全时，只在同会话唯一候选中匹配。
- 区分成功外发、发送失败、显式静默丢弃，以及到回合结束仍无真实回执的退场候选。
- 检查带图回合是否出现可识别视觉细节，以及括号内是否含内部词。
- 抽取引号内容，并分成找到、较旧语料中找到、自己说的、查不到、无法判断五类。
- 只把签名有效或明确属于历史豁免的运维方行作为 ops 语料。
- 输出 schema `3` JSONL，带原文抽样和语料完整性计数。

## 设计思路

- **审计只观察，不拦截。** 内容过滤器会误杀，也会把“被吞了什么”一起隐藏。硬停由 gate 负责；audit 记录丢弃原因，并保留足够上下文供事后核对。
- **模型生成了不等于平台发出去了。** `assistant/message` 只证明模型产出文本；只有真实发送调用之后的 `onSendResult()` 能证明平台送达，也能覆盖没有 assistant 正文的媒体和流式路径。
- **负结论必须有完整语料。** 短期文件读不了或有坏 JSON 行时，“没找到引号”不能证明不存在，这类情况记为 `unmeasured` 并让 `quoteUnverified` 保持 `null`。ops 语料也只接受签名有效行或明确 legacy 行。
- **启发式与结局字段必须分开。** 视觉词和内部词只是保留原文抽样的粗略工具；`silence` 和 `exit` 放在 `dropped`，`sendOk:false` 是发送失败，不是主动丢弃，统计不会混淆不同结局。

## 配置

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `file` | `<KOI_HOME>/.koi/audit.jsonl` | 只追加审计流水路径。 |
| `visualWords` | 内置短语表 | 判断带图回复是否提到视觉细节的词表。 |
| `internalWords` | 内置词表 | 判断括号内是否疑似出现内部用语。 |
| `skipSessionPrefixes` | `session-chat-`, `session-hb-` | 视为 ops 或心跳、不走普通外发统计的会话前缀。 |
| `KOI_HOME` | 用户主目录 | 审计、短期、chat 和密钥文件的查找基准。 |

## 接口

| 名称 | 类型 | 作用 |
| --- | --- | --- |
| `koi-audit` | 插件 id | 包导出的挂载名。 |
| `tools` | 注入服务 | 为宿主兼容而声明的依赖。 |
| `onSendResult` 订阅 | gate 回调 | 接收真实成功、失败、目标与长度。 |
| `session/event` | 事件订阅 | 观察用户消息、assistant 消息和回合结束。 |
| `dispose` | 事件订阅 | 插件卸载时注销发送结果回调。 |
| `audit.jsonl` schema `3` | 输出契约 | `source`、`sendOk`、`dropped`、`status`、引号档位、语料计数与抽样。 |

## 验证

在仓库根目录运行：

```bash
node plugins/dsh-koi-audit/test-audit.mjs
```

测试逐条打印 `✅` 或 `❌`，结束时输出 `N 通过 / 0 失败`；全部通过时退出码为 `0`。

## 说明 / 限制

- 虽然声明注入 `tools`，本插件并不注册工具。
- 视觉细节和内部词判断是短语表启发式，不是语义分类器。
- `auditId` 由 session、turn、step 和事件时间推导，刻意不冒充平台消息 id。
- 安装的 gate 没有 `onSendResult` 时，audit 退回 `assistant/message`，并记 `source: assistant`、`sendOk: null`。
- ops 引号核验读取 `.koi/chat.key`、`.koi/chat.sign.json` 和 `.koi/chat.jsonl`；audit 不生成也不改写密钥。
- 统计工具不在本包内，修改输出契约时要同步协调其消费者。
