# dsh-koi-gate

中文 | [English](./README.md)

决定什么消息能唤醒 agent、什么内容发送前必须压掉，以及平台是否真的发送成功。

## 它做什么

- 提供群聊入口中间件：直接 @、名字、配置的对端别名和图片可立即放行；弱对话先累积，再交给小模型判断是否叫醒。
- 提供发送侧 `allow()` 与 `allowOnce()`，处理显式静默词和重复退场语。
- 在 order `97` 注入出口自查段。
- 包装 `bot.send`、`bot.sendMedia` 和流式 `update`/`complete`，输出带关联上下文的投递结果。
- 暴露 `onSendResult()`，让 audit 观察平台发送成功或失败。
- 导出静默词、旁白、漏话、退场语以及本轮带图/点名标记等纯函数。

## 设计思路

- **三个包合成一条完整链路。** 纯规则、出口检查和入口唤醒门控回答的其实是同一个“能不能过边界”问题。拆开后有三个接缝，还会出现半边加载、半边静默失效。
- **出口硬门只拦明确声明，不按内容形状猜。** `allow()` 只丢空串、精确的 `#静默#`，以及违反规则的重複退场语。括号、内部措辞和语义意图不再用正则猜，因为旧启发式曾静默吞掉正常回复。代价是内容质量更依赖提示词与 agent 自己主动表达沉默。
- **入口先看结构，再看语义。** 直接 @、名字、配置别名或图片可以立即放行；其余群聊先攒到阈值，再把最近上下文交给小模型。这样减少噪声唤醒，但阈值前已经很重要的话可能被漏掉。
- **模型判断失败时默认不叫。** 如果异常时兜成放行，等于所有故障都变成“永远接话”，既烧 token 又破坏注意力。因此失败走 fail-closed，并留下日志。
- **退场压制是状态判断，不是无限词表。** 退场语用锚定模式识别；同类重复和连续第三条会被压掉。入口把“带图/点名”写进共享标记，出口据此禁止用一句泛泛告别敷衍。
- **发送意图与发送事实分开。** `assistant/message` 只能证明模型生成了内容，包装后的平台调用才证明真的外发。附件和流式路径各自包装，因为并不都经过普通 `send`。

## 配置

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `rivalAliases` | `[]` | 可直接触发唤醒的对端字面别名。 |
| `directPrompt` | 空 | 传给入口判断模型的可选人设文本。 |
| `KOI_HOME` | 用户主目录 | `.koi`、白名单、规则文件和 lexicon 的查找基准。 |
| `KOI_AGENT_NAME` | `agent` | 用于名字匹配的 agent 名。 |
| `QQBOT_ALIASES` | 面板别名或 agent 名 | 视为在叫 agent 的字面别名。 |
| `QQBOT_SELF_OPENID` | 空 | 用于区分“@ 自己”和“@ 别人”的自身 openid。 |
| `QQBOT_GATE_RULES` | `<KOI_HOME>/.koi/gate-rules.json` | 运行时硬放行、阈值和批窗口规则文件。 |
| `QQBOT_CONSECUTIVE` | `3` | 语义判断前需要累积的弱消息条数。 |
| `QQBOT_BATCH_MS` | `300000` | 按发送者计算的批窗口毫秒数。 |
| `QQBOT_CONTINUE_MS` | `120000` | 判断级消息延续现有对话的时间窗口。 |
| `QQBOT_SELFTALK_OFF` | 未设置 | 设为 `1` 时跳过入口判定，但仍保留本轮标记。 |
| `QQBOT_SELFTALK_LOG` | 开启 | 设为 `0` 时关闭门控决策日志。 |
| `MODEL_PROVIDER`, `MODEL_NAME` | 空 | 入口判断可选的 provider/model。 |

## 接口

| 名称 | 类型 | 作用 |
| --- | --- | --- |
| `koi-gate` | 插件 id | 包导出的挂载名。 |
| `koi:outbound`，order `97` | 注入段 | 发送前自查说明。 |
| `koi:last-send` | 运行时上下文快照 | 一行：最近一次发图的时间、成败、发给谁（群/私聊）。每次发送覆盖，不留历史。 |
| `allow`, `allowOnce` | 导出函数 | 出口丢弃判断，以及状态行节流辅助。 |
| `createGate`, `installSelftalk` | 导出函数 | 构造或安装群聊入口中间件。 |
| `installSendLog`, `onSendResult` | 导出函数 | 包装平台发送并发布关联投递结果。 |
| `system-prompt/assemble` | 事件订阅 | 加入出口自查段。 |
| `session/event` | 事件订阅 | 记录用于发送关联的 session、turn、step。 |
| `send`, `sendMedia`, 流式 `update`, 流式 `complete` | 被包装的 bot 方法 | 输出投递日志与回调结果。 |
| `guardExit`, `isSilenceToken`, `shouldDropLeak`, `isPureAside` | 导出判断函数 | 可复用的确定性检查。 |

## 验证

在仓库根目录运行：

```bash
for f in plugins/dsh-koi-gate/test-*.mjs; do node "$f" || exit 1; done
```

测试逐条打印 `✅` 或 `❌`，结束时输出 `N 通过 / 0 失败`。全部通过时退出码为 `0`。

## 说明 / 限制

- 当前出口 `allow()` 只硬丢空输出、静默词，以及违反重复或本轮语境的退场语，不是内容分类器。
- `opts.statusDedup` 与 `allowOnce()` 仍存在，但当前 `allow()` 路径不会调用状态行去重。
- 入口门控要求群聊适配层调用返回的中间件，并正确处理 `stop()`。
- 投递回执要求通道对象真的暴露 `send`、`sendMedia` 或 `openStream`。
- 入口判断使用配置的 provider；未配置时按宿主可用列表选择。找不到 provider 时该轮判断分支直接放行，不产生模型结论。
- `.koi/gate-rules.json` 会被短时缓存并在运行中重读；其中硬放行 pattern 会编译成正则。
