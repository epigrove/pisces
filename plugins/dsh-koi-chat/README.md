# dsh-koi-chat

[中文](./README.zh-CN.md) | English

Provides the agent's HMAC-aware, append-only conversation channel with the operator and Pisces owner, plus a daily proposal loop.

## What it does

- Uses one `chat.jsonl` for `koi`, `ashu`, and `master` messages without rewriting history; it verifies inbound HMAC signatures and marks unsigned or bad-signature entries.
- Injects unread messages into dedicated `session-chat-*` sessions at order `94`, bounded by a configurable batch limit.
- Advances per-source cursors and seen ids only after a successful `turn/end`, using one atomic read-state snapshot.
- Wakes the agent through `agent.followup()` when new messages arrive, using a file watcher plus per-source polling fallbacks.
- Exposes `talk_to_sister`, including `request`-only outstanding-message limits and an explicit 4,000-character rejection limit.
- Generates a daily proposal from memory and recent chat, removes repeated or incomplete proposals, and sends it through the same channel.

## Design rationale

- **Single-writer append semantics avoid merge conflicts.** `chat.jsonl` is the cross-process contract. Every writer appends only its own source; corrections are new messages that reference the old one. Shared mutable files would need locking and still leave ambiguous partial updates.
- **Read state is committed after successful delivery.** Prompt assembly may fail or be cancelled. Holding cursor and seen ids in one snapshot and committing only after a successful turn end can replay a message after failure, but that is safer than losing it.
- **Signatures raise spoofing cost but do not isolate users.** Any same-user process can still read the key. The signature catches casual `from: ashu` spoofing and records bad or unsigned senders for review; true isolation requires separate users or socket permissions.
- **Wake triggers are serialized and routed by source.** A watcher, operator poll, and faster owner-panel poll share one in-flight wake. Operator and owner use separate `session-chat-*` sessions so history is not mixed and replies route correctly with `to`.

## Configuration

| Key | Default | Effect |
| --- | --- | --- |
| `dir` | Resolved KOI data directory | Base for chat, keys, read state, proposals, and overrides. |
| `injectLimit` | `6`, then panel `defaults.injectLimit` | Maximum unread messages inserted per assembly batch. |
| `maxOutstanding` | `3` | Maximum unanswered `request` messages sent by the agent. |
| `wakeMinutes` | `5`, then panel `defaults.wakeMinutes` | Operator-channel polling interval. |
| `masterPollSeconds` | `5` | Owner-panel polling interval; `0` disables it. |
| `iterateHour` | `4` | Local hour for daily proposal generation. |
| `iterateMinute` | `0` | Local minute for daily proposal generation. |
| `iterateChatDays` | `3` | Recent short-memory files used as proposal context. |
| `iterateChatLimit` | `60` | Maximum recent chat messages considered by the proposal prompt. |
| `iterateProvider` | Empty | Explicit proposal provider. |
| `iterateModel` | Empty | Explicit proposal model. |
| `iterateCapabilities` | Empty | Capability description supplied to the proposal model. |
| `memoryFile` | `<KOI_HOME>/.koi/memory.md` in iterate defaults | Legacy memory path used as fallback context. |
| `shortDir` | `<KOI_HOME>/.koi/short` in iterate defaults | Recent chat source for proposal generation. |
| `KOI_HOME` | User home directory | Shared data-root fallback. |
| `MODEL_PROVIDER`, `MODEL_NAME` | Empty | Last-resort model route when no explicit, panel, or live-session route exists. |
| `DSH_HOME` | `~/.dsh` | Root used to locate the persona profile. |
| `QQBOT_PROFILE` | `koi` | Profile name used when reading persona text. |
| `QQBOT_ITERATE_NOW` | Unset | Set to `1` to generate one proposal shortly after startup. |
| `QQBOT_ASK` | Unset | Startup question answered from persona and memory, then sent through chat. |

## Interface

| Name | Type | Effect |
| --- | --- | --- |
| `koi-chat` | plugin id | Mount name exported by the package. |
| `tools` | injected service | Required for `talk_to_sister`. |
| `system-prompt/assemble` | event subscription | Injects unread messages into dedicated chat sessions. |
| `session/event` turn end | event subscription | Commits read state only on successful completion. |
| `koi:chat`, order `94` | prompt section | Source label, unread messages, trust marks, and reply hint. |
| `talk_to_sister` | tool | Appends a `chat` or `request` message to the channel. |
| file watcher, operator poll, owner poll | timers | Trigger serialized `agent.followup()` wake-ups. |
| daily proposal timer | effect timer | Generates and sends one proposal at the configured local time. |

## Verify

Run from the repository root:

```bash
for f in plugins/dsh-koi-chat/test-*.mjs; do node "$f" || exit 1; done
```

The five test files print `✅` or `❌` per assertion and end with `N 通过 / 0 失败`. A passing run exits with status `0`.

## Notes / Limitations

- Ops injection is restricted to session ids beginning with `session-chat-`; unrelated QQ, agent, and unknown sessions receive no ops context and do not advance its cursor.
- The HMAC key protects against casual forgery, not a hostile process running as the same operating-system user.
- A read-state save failure deliberately replays messages later instead of losing them.
- `talk_to_sister` rejects empty or over-4,000-character messages; it does not silently truncate.
- An unreadable `chat.jsonl` is reported as unavailable and neither injection nor reply sending advances as if the channel were empty.
- LLM is not a hard injected dependency. Missing LLM configuration disables the proposal branch while the conversation channel remains available.
- The proposal branch requires a complete provider/model route; a missing route logs a skip rather than creating an invalid request.
