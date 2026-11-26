# Examples

[中文](./README.zh-CN.md) | English

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
| `persona.template.md` | A neutral persona template (English); `persona.template.zh-CN.md` is the Chinese one |

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
