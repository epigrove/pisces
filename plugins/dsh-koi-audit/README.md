# dsh-koi-audit

[中文](./README.zh-CN.md) | English

Writes append-only outbound and quote-checking evidence without blocking messages.

## What it does

- Subscribes to `dsh-koi-gate` send receipts and records whether the platform actually accepted each send.
- Pairs an `assistant/message` candidate with a receipt by session, turn, and step, falling back to a unique same-session match.
- Records successful sends, failed sends, explicit silence drops, and exit candidates that never produced a real receipt.
- Checks whether image turns contain identifiable visual details and whether bracketed text contains internal terms.
- Extracts quoted passages and classifies them as found, aged, self-authored, unknown, or unmeasured.
- Reads the ops corpus only from signed or explicitly grandfathered legacy rows and emits schema `3` JSONL with source samples and corpus counters.

## Design rationale

- **Audit observes; it does not intercept.** Content filters create false positives and hide evidence of what was lost. The gate owns the narrow hard stop; audit records why a row was dropped and preserves enough context for review.
- **A generated message is not a sent message.** `assistant/message` proves generation. Only `onSendResult()` proves platform delivery after the real send call, including media and streamed paths that may lack assistant body text.
- **Negative conclusions require measured evidence.** If a short-memory file is unreadable or has bad JSON lines, “quote not found” is not proven. Those cases become `unmeasured`, and `quoteUnverified` remains `null`. The ops corpus is also accepted only from valid signed rows or explicit legacy lines.
- **Heuristic checks and outcomes stay visibly distinct.** Visual and internal-term lists are rough measuring tools with source samples retained. `silence` and `exit` occupy a separate `dropped` field; `sendOk:false` is a send failure, not a dropped message, so statistics do not mix outcomes.

## Configuration

| Key | Default | Effect |
| --- | --- | --- |
| `file` | `<KOI_HOME>/.koi/audit.jsonl` | Append-only audit output path. |
| `visualWords` | Built-in phrase list | Terms used to estimate whether an image turn contains visual detail. |
| `internalWords` | Built-in term list | Terms that mark bracketed text as potentially internal. |
| `skipSessionPrefixes` | `session-chat-`, `session-hb-` | Sessions treated as ops or heartbeat rather than ordinary outbound. |
| `KOI_HOME` | User home directory | Base for audit, short-memory, chat, and key files. |

## Interface

| Name | Type | Effect |
| --- | --- | --- |
| `koi-audit` | plugin id | Mount name exported by the package. |
| `tools` | injected service | Declared dependency for host compatibility. |
| `onSendResult` subscription | gate callback | Receives real send success, failure, target, and length. |
| `session/event` | event subscription | Observes user messages, assistant messages, and turn end. |
| `dispose` | event subscription | Removes the send-result callback during disposal. |
| `audit.jsonl` schema `3` | output contract | `source`, `sendOk`, `dropped`, `status`, quote tiers, corpus counters, and samples. |

## Verify

Run from the repository root:

```bash
node plugins/dsh-koi-audit/test-audit.mjs
```

The test prints `✅` or `❌` per assertion and ends with `N 通过 / 0 失败`; success exits with status `0`.

## Notes / Limitations

- Audit does not expose a tool despite injecting `tools`.
- Visual-detail and internal-term detection are phrase-list heuristics, not semantic classifiers.
- `auditId` is derived from session, turn, step, and event time. It is intentionally not presented as a platform message id.
- When the installed gate lacks `onSendResult`, audit falls back to `assistant/message` and marks `source: assistant` with `sendOk: null`.
- Ops quote verification reads `.koi/chat.key`, `.koi/chat.sign.json`, and `.koi/chat.jsonl`; audit never creates or rewrites the key.
- The statistics tool is outside this package, so output-contract changes must be coordinated with its consumers.
