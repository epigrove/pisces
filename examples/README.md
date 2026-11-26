# 示例 / Examples

## 先跑这个 / Start here

```bash
node examples/walkthrough.mjs
```

三十秒，不写文件、不连服务，纯计算。它会演示三件事：

1. **衰减**：一条 40 天半衰期的记忆，在不同时间点值多少分
2. **出口规则谓词**：`isPureAside` / `shouldDropLeak` 对示例句的判断，以及为什么
3. **这套设计在回答什么问题**

输出节选：

```
半衰期 40 天 → 衰减系数 α = 0.1867
     0 天  │ 1.0000 │ 正常显示
    40 天  │ 0.5000 │ 正常显示      ← 半衰期到了，正好一半
  2000 天  │ 0.2420 │ 变淡          ← 五年前的事，仍然不是 0
```

**幂律的尾巴永远不为零。** 这是整个记忆设计的起点：指数衰减会在某天精确归零，
而归零等于删除——但"它在算上归零了"和"它被删掉了"对使用者没有区别。

## 数据样例 / Sample data

`data/` 里是**格式示例**，不是真实数据。所有标识符都是占位（`人物甲`、`00000001`）。

| 文件 | 内容 |
|---|---|
| `data/medium.jsonl` | 中期记忆：幂律衰减，会变淡 |
| `data/long.jsonl` | 长期记忆：不衰减 |
| `data/lexicon.json` | 印象词典：人对人/物的看法 |
| `persona.template.md` | 中性人设模板，自己填 |

一条记忆长这样：

```json
{
  "id": "ex000001",
  "at": 1794719827255,
  "scope": "medium",
  "curve": { "alpha": 0.26 },
  "tier": "normal",
  "source": "seen",
  "verified": true,
  "who": "人物甲",
  "body": { "text": "示例：人物甲喜欢深烘咖啡。" }
}
```

`source` 的取值是 `seen`（亲眼看见）、`heard`（听说）或 `inferred`（推断）；
`verified` 表示是否核过，默认 `false`；`who` 表示这条记忆关于谁。

**`source` 和 `verified` 是这套设计里性价比最高的两个字段。**
"亲见"和"推断"混在一起，agent 会把猜测当事实复述；分开之后，检索能按可信度筛。

> `walkthrough.mjs` 演示的是可单独调用的纯谓词，不是通道默认的 `allow()` 结果。
> `allow()` 只硬拦静默词和退场重复；括号底稿与内部词不再按内容形状拦截。

---

# English

## Start here

```bash
node examples/walkthrough.mjs
```

Thirty seconds; writes nothing, connects to nothing, pure computation. Demonstrates three things:

1. **Decay**: how much a memory with a 40-day half-life is worth at different points in time
2. **Outbound predicates**: how `isPureAside` / `shouldDropLeak` classify sample text
3. **What problem this design solves**

Sample output:

```
half-life 40 days → α = 0.1867
     0 days │ 1.0000 │ normal
    40 days │ 0.5000 │ normal      ← half-life reached, exactly half
  2000 days │ 0.2420 │ faded       ← five years on, still not zero
```

**A power-law tail never reaches zero.** That is the starting point of the whole memory design:
exponential decay hits exactly zero one day, and zero means deletion — yet "computed to zero" and
"deleted" are indistinguishable to whoever relies on it.

## Sample data

`data/` holds **format samples**, not real data. All identifiers are placeholders (`人物甲`, `00000001`).

| File | Contents |
|---|---|
| `data/medium.jsonl` | Medium-term memory: power-law decay, fades |
| `data/long.jsonl` | Long-term memory: no decay |
| `data/lexicon.json` | Impression lexicon: how the agent sees people and things |
| `persona.template.md` | A neutral persona template — fill it in yourself |

One record looks like this:

```json
{
  "id": "ex000001",
  "at": 1794719827255,
  "scope": "medium",
  "curve": { "alpha": 0.26 },
  "tier": "normal",
  "source": "seen",
  "verified": true,
  "who": "人物甲",
  "body": { "text": "sample: 人物甲 prefers dark roast coffee." }
}
```

`source` is `seen`, `heard`, or `inferred`; `verified` defaults to `false`; `who`
identifies the person the record is about.

**`source` and `verified` are the highest-value fields in this design.**
Mixing "seen" with "inferred" makes the agent restate guesses as facts; kept apart, retrieval can
filter by trust.

> `walkthrough.mjs` demonstrates standalone predicates, not the channel's default `allow()`
> result. `allow()` hard-drops only silence and repeated exit phrases; bracket drafts and
> internal words are no longer dropped by content shape.
