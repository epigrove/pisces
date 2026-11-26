# 接自己的通道 / Wiring up your own channel

> 本仓库的通道层只做一件事：**把平台消息转成 agent 能看懂的文本，把 agent 的话发回平台。**
> 人格、记忆、判断都不在通道里。
>
> The channel layer does exactly one thing: **turn platform messages into text the agent understands,
> and send the agent's words back.** Persona, memory and judgement never live in a channel.

参考实现用的是 `@tencent-connect/dsh-qqbot`（QQ）。这份文档讲怎么接别的：Telegram、Discord、Slack、桌面、命令行……

---

## 一、先分清两个方向

```
        入站 / inbound                       出站 / outbound
平台上有人说话 ──────────▶ agent 决定说什么 ──────────▶ 发回平台
                ↑                                    ↑
          ✋ 先问门控                         ✋ 先问出口判定
        dsh-koi-gate                        dsh-koi-gate
```

**这是两个独立的关卡，别搞混：**

| 关卡 | 包 | 问题 | 在哪调 |
|---|---|---|---|
| 门控 | `dsh-koi-gate`（`createGate`） | 这条消息**该不该**唤醒 agent | 入站，消息进 agent 之前 |
| 出口 | `dsh-koi-gate`（`allow`） | agent 说的这句**能不能**发出去 | 出站，发给平台之前 |

---

## 二、为什么两处都必须由通道调用

DSH 的事件全是**通知型**（`user/message`、`assistant/message` 都改不了内容、拦不住流程）。
所以：

- 想「不让 agent 看见某条消息」→ 只能在通道**收到时**不交给它
- 想「不让某句话发出去」→ 只能在通道**发送前**丢弃

这不是设计缺陷，是明确的职责划分：**判定逻辑在包里，喊停的点在通道。**

好消息是：每个通道只需要**两行调用**，判定逻辑一行都不用写。

---

## 三、最小接入

### 出站（必须做）

```js
import { allow } from 'dsh-koi-gate';

async function send(text, target) {
  const verdict = allow(text, { target });
  if (verdict.drop) {
    // 不要发，也**不要**补一句替代的话——
    // 被拦下的话本来就是"不该被看见"的，补一句反而暴露了它存在
    console.log(`[outbound] 丢弃(${verdict.reason}): ${text.slice(0, 40)}`);
    return;
  }
  await platform.send(target, text);
}
```

`reason` 的取值见 [dsh-koi-gate 的 README](../plugins/dsh-koi-gate/README.md)。

### 入站（群聊/多人群组才需要）

```js
import { createGate } from 'dsh-koi-gate';

const gate = createGate(bot, ctx, config);

async function onMessage(msg) {
  const pass = await new Promise((resolve) => {
    let passed = false;
    gate(
      { message: msg, stop: () => { /* 标记这条不发出去 */ } },
      async () => { passed = true; },
    ).then(() => resolve(passed));
  });
  if (!pass) return;   // 门控说别打扰 agent

  await agent.followup(buildPrompt(msg));
}
```

私聊 / 一对一场景通常不需要门控——直接交给 agent。

---

## 四、入站消息要提供什么

门控要判断「这是谁说的、冲谁说的」，所以消息对象至少要有：

| 字段 | 用途 |
|---|---|
| `kind` | `'group'` / `'c2c'`——私聊直接放行 |
| `content` | 文本（门控要匹配名字、@） |
| `senderName` | 谁说的 |
| `senderIsBot` | 机器人消息不接 |
| `mentions` | @ 了谁。**关键在于能不能判断"@ 的是不是 agent 本尊"** |
| `groupOpenid` / `senderId` | 目标标识，用于退场去重 |

⚠️ **`mentions` 是最容易做错的一个。** 你的平台如果只能给出「@ 了一个名字」而不知道是不是本 agent，
那就要在通道层做映射：拿到 agent 自己的平台 id，逐个比对。判断逻辑不要写进业务插件——
那是平台细节。

参考 `dsh-koi-gate` 的 `atSelf()`，看它怎么处理 QQ 的 `mentions[].is_you` 与 openid 兜底。

---

## 五、身份判断归通道，不要归插件

这是整个架构里最硬的一条：

> **删掉所有平台相关代码，插件还能工作，它就是干净的。**

所以：

| ✅ 通道层该做的事 | ❌ 插件层不该做的事 |
|---|---|
| 把平台 id 映射成「用户 / 别人 / 机器人」 | 认识 `openid`、`user_id`、`chat_id` 这种字段名 |
| 处理 @ 语法、群名片、消息类型 | 写 `if (platform === 'qq')` |
| 平台限流、重试、消息分片 | 关心一次能发多少字 |

**判据**：插件里的逻辑，换一个通道能不能原样复用？不能，就是放错层了。

---

## 六、出站前还要处理的平台细节

这些属于通道自己的活，不是判定逻辑：

| 事情 | 说明 |
|---|---|
| **纯文本化** | 大多数平台不支持 Markdown 表格/代码块，要降级 |
| **长度分片** | 超长消息要拆开，别被平台截断 |
| **速率限制** | 平台有频率上限，超了会丢消息 |
| **流式** | 如果平台支持流式，注意**过滤要在最终文本上做**，别逐字过滤（会误判半句） |

最后一条尤其容易踩：流式输出时，`（` 单独一个字符就判定「这是括号旁白」会误杀。
**等到一条消息完整了再判。**

---

## 七、接完怎么验证

```bash
node ops/test-leak-guard.mjs   # 出口规则的基本行为
node examples/walkthrough.mjs  # 看一眼判定长什么样
```

然后手动验证三件事：

1. **说句话**——正常内容能发出去
2. **让它输出静默词**——这条不该出现在任何通道上（`allow()` 只负责这一条硬拦）
3. **群里 @ 别人**——agent 不该被唤醒

三条都过，说明两处调用接对了。

> **`allow()` 到底拦什么，说清楚免得误解。**
> 它只硬拦**静默词**（她自己声明的"这次不说"）和**退场语连击**。
> 括号旁白、内部词这些**不在这里拦**——本项目在 2026-11-21 明确取消了按内容形状猜的拦截，
> 因为猜不准还误伤，最后只会让她学会绕。它们靠**提示词自律 + 事后审计**（`dsh-koi-audit` 的日志）。
>
> 如果你的部署**确实需要**硬拦括号旁白，自己组合谓词，别指望 `allow()`：
> ```js
> import { allow, isPureAside, shouldDropLeak } from 'dsh-koi-gate';
> const drop = allow(text, { target }).drop
>   || isPureAside(text)          // 整条只有括号旁白
>   || shouldDropLeak(text);      // 带内部词（cordis.patch.yml 之类）
> ```
> 但要想清楚代价：拦得越硬，她越学不会"什么时候不该说"。

---

# English

## 1. Two directions, two checkpoints

```
        inbound                              outbound
someone speaks ──────────▶ agent decides ──────────▶ send to platform
                ↑                                    ↑
          ✋ ask the gate                      ✋ ask the exit check
        dsh-koi-gate                        dsh-koi-gate
```

| Checkpoint | Package | Question | Where |
|---|---|---|---|
| Gate | `dsh-koi-gate` (`createGate`) | Should this message **wake** the agent? | inbound, before the agent sees it |
| Exit | `dsh-koi-gate` (`allow`) | May this sentence **be sent**? | outbound, before the platform sees it |

## 2. Why the channel must call both

Every DSH event is a **notification** — it cannot rewrite content or block a flow. So:
"don't let the agent see this" can only happen at receive time, and "don't let this sentence out"
can only happen at send time.

That's not a flaw; it's the division of labour: **the decision lives in the package, the stop lives
in the channel.** Each channel needs **two lines of glue**, and zero lines of decision logic.

## 3. Minimal integration

**Outbound (required)**

```js
import { allow } from 'dsh-koi-gate';

async function send(text, target) {
  if (allow(text, { target }).drop) return;   // don't send, and don't send a replacement
  await platform.send(target, text);
}
```

> `allow()` hard-drops **only** the silence token and repeated exit phrases.
> Bracket asides and internal words are intentionally **not** intercepted — that decision was
> reversed on 2026-11-21 (shape-guessing drops were both inaccurate and harmful), so they are
> handled by prompt discipline plus post-hoc auditing. If your deployment wants them dropped,
> compose the predicates yourself (`isPureAside`, `shouldDropLeak`) and accept the tradeoff.

**Inbound (only for group chats)**

```js
import { createGate } from 'dsh-koi-gate';
const gate = createGate(bot, ctx, config);
// call gate({ message, stop }, next); if next() runs, deliver to the agent
```

## 4. What inbound messages must carry

`kind` (`group`/`c2c`) · `content` · `senderName` · `senderIsBot` · `mentions` · `groupOpenid`

⚠️ **`mentions` is the easiest thing to get wrong.** If your platform only tells you "someone was
mentioned by name" without saying whether it's *this* agent, map it in the channel — get the agent's
own platform id and compare. Never push platform details into business plugins.

## 5. Identity mapping belongs to the channel

> **Delete every platform-specific line; if the plugin still works, it was clean.**

| ✅ Channel's job | ❌ Never in plugins |
|---|---|
| Map platform ids to user / other / bot | Knowing `openid`, `user_id`, `chat_id` |
| Handle mention syntax, display names | `if (platform === 'qq')` |
| Rate limits, retries, chunking | How many characters fit |

**Test**: could this logic be reused verbatim on another channel? If not, it's in the wrong layer.

## 6. Channel-level details before sending

Plain-text downgrade · chunking · rate limiting · streaming.

The streaming one bites: filtering character-by-character will misfire on a lone `(`.
**Judge only complete messages.**

## 7. How to verify

1. Normal content goes through.
2. The silence token is **not sent**; it is the hard-drop path in `allow()`.
3. A bracket-only aside passes `allow()` unless your deployment composed extra predicates.
4. In a group, a message mentioning someone else does not wake the agent.

All four pass, and both calls are wired correctly.
