# dsh-koi-gate

[中文](./README.zh-CN.md) | English

Controls what may wake the agent, what must be suppressed before sending, and whether a platform send actually succeeded.

## What it does

- Provides inbound group middleware that passes direct mentions, names, configured peer aliases, and images, while batching weak conversation for a small-model judgment.
- Provides outbound `allow()` and `allowOnce()`, with explicit silence-token and repeated-exit guards.
- Injects an outbound self-check at order `97`.
- Wraps `bot.send`, `bot.sendMedia`, and stream `update`/`complete` calls to emit correlated delivery results.
- Exposes `onSendResult()` so audit can observe real platform success or failure.
- Exports pure predicates for silence, aside text, leak text, exit phrases, and per-turn image/name flags.

## Design rationale

- **Three packages became one chain.** Pure rules, outbound checks, and inbound wake gating all answered the same boundary question. Splitting them created three integration points and allowed one half to load while another silently stayed disconnected.
- **The outbound hard gate blocks explicit declarations, not guessed content shape.** The 2026-11-21 decision removed shape-based drops. `allow()` drops an empty message or exact `#静默#`, then enforces repeated and consecutive exit rules; parentheses, internal wording, and semantic intent are not classified by regex because the old heuristics silently swallowed normal replies. The cost is that content quality depends more on prompt discipline and explicit silence.
- **Inbound wake-up is structural first and semantic second.** A direct mention, name, configured alias, or image can pass immediately. Other group chatter must accumulate to the threshold before a small model sees recent context; rapid weak repeats are suppressed rather than each starting a judge call, which saves tokens. This reduces noisy wake-ups but can delay an important message until enough context exists.
- **Model failure fails closed.** If the judge errors, the turn is not woken. Falling back to "always wake" would make every failure equivalent to replying to everything and burn tokens and attention.
- **Exit suppression is stateful rather than an ever-growing word list.** Exit phrases use anchored patterns; repeated same-category exits and a third consecutive exit are blocked. Inbound image/name flags are shared with outbound code so a direct request cannot be dismissed with a generic goodbye.
- **Send intent and send fact are different.** `assistant/message` proves generation; only the wrapped platform call proves delivery. Attachments and streaming need separate wrappers because they do not all pass through ordinary `send`.

## Configuration

| Key | Default | Effect |
|---|---|---|
| `rivalAliases` | `[]` | Literal peer aliases that can directly trigger a wake-up. |
| `directPrompt` | Empty | Optional persona text passed to the wake judge. |
| `KOI_HOME` | User home directory | Base for `.koi`, whitelist, rule files, and lexicon lookup. |
| `KOI_AGENT_NAME` | `agent` | Agent name used for name matching. |
| `QQBOT_ALIASES` | Panel aliases or agent name | Literal aliases treated as addressing the agent. |
| `QQBOT_SELF_OPENID` | Empty | Self openid used to distinguish mentions of the agent from mentions of others. |
| `QQBOT_GATE_RULES` | `<KOI_HOME>/.koi/gate-rules.json` | Runtime hard-pass, threshold, and batch-window rules. |
| `QQBOT_CONSECUTIVE` | `3` | Weak-message count required before semantic wake judging. |
| `QQBOT_BATCH_MS` | `300000` | Per-sender batch window in milliseconds. |
| `QQBOT_CONTINUE_MS` | `120000` | Window in which judge-level messages continue an active exchange. |
| `QQBOT_SELFTALK_OFF` | Unset | Set to `1` to skip inbound judging while retaining turn flags. |
| `QQBOT_SELFTALK_LOG` | Enabled | Set to `0` to disable gate decision logs. |
| `MODEL_PROVIDER`, `MODEL_NAME` | Empty | Optional provider/model for the wake judge. |

## Interface

Plugin id: `koi-gate`. Injected services: none.

| Name | Type | Effect |
|---|---|---|
| `system-prompt/assemble` | event subscription | Adds the outbound self-check section. |
| `session/event` | event subscription inside `createGate()` | Tracks session, turn, and step for send correlation. |
| `koi:outbound`, order `97` | prompt section | Sending self-check instructions. |
| `koi:last-send` | runtime context snapshot | One line: when the last media send happened, whether it succeeded, and to which scope. Overwritten on every send; no history. |
| `allow`, `allowOnce` | exported functions | Outbound drop checks and state-line throttling helper. |
| `createGate`, `installSelftalk` | exported functions | Build or install inbound group middleware. |
| `installSendLog`, `onSendResult` | exported functions | Wrap platform sends and publish results. |
| `send`, `sendMedia`, stream `update`, stream `complete` | wrapped bot methods | Emit delivery logs and callbacks. |
| `guardExit`, `isSilenceToken`, `shouldDropLeak`, `isPureAside` | exported predicates | Reusable deterministic checks. |
| Agent tools | none | The plugin exposes no tools. |

## Verify

Run from the repository root:

```bash
for f in plugins/dsh-koi-gate/test-*.mjs; do node "$f" || exit 1; done
```

Tests print `✅` or `❌` per assertion and end with `N 通过 / 0 失败`; a passing run exits with status `0`.

## Notes / Limitations

- Current `allow()` hard-drops only empty output, the silence token, and exit phrases that violate repetition or turn-context rules.
- `opts.statusDedup` and `allowOnce()` remain available, but `allow()` does not invoke status-line deduplication.
- Inbound gating requires a group-channel adapter that calls the returned middleware and honors `stop()`.
- Delivery receipts require the channel object to expose `send`, `sendMedia`, or `openStream`.
- A missing provider leaves the same-turn judge branch without a model decision.
- Rules in `.koi/gate-rules.json` are cached briefly and reloaded at runtime; hard-pass patterns are compiled as regular expressions.
