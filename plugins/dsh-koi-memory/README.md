# dsh-koi-memory

[中文](./README.cn.md) | English

Stores layered long-term context, recent conversation, and fact records while keeping source data append-oriented.

## What it does

- Models four conceptual layers, splitting facts between decaying medium-term `medium.jsonl` and non-decaying long-term `long.jsonl`.
- Buffers human and assistant messages by session, writes them to daily JSONL files, and injects recent conversation at order `95`.
- Scores medium-term facts with recency, importance, recall reinforcement, duplicate dilution, and revision penalties.
- Recalls facts with exact, fuzzy, split-term, and nearby-time fallbacks without calling an LLM.
- Scrubs names, account ids, and phone numbers before content reaches the model.
- Marks obsolete long-term records in a derived sidecar index and preserves v8 envelopes for scope, curve, body, source, verification, and related metadata.

## Design rationale

- **The four runtime layers answer different questions.** Short-term context answers "what was just said," medium-term memory answers "what may still matter," long-term memory answers "what was deliberately kept," and legacy facts preserve the older `memory.md` contract. Fixed core and persona rendering have moved to lexicon.
- **The 60-second short-term flush is a deliberate tradeoff.** Writing every message immediately increases disk I/O and makes each chat turn depend on file writes. Batching lowers that cost while keeping the current turn in memory. The cost is that a hard crash can lose up to one flush window, and external readers can briefly lag. A graceful stop flushes the pending batch.
- **Cross-session isolation is strict.** Every short message records its session id. A known session with no match returns empty rather than falling back to another session's private conversation; only the explicit legacy path with an unknown session id may use the global pool.
- **No source record is deleted.** Medium-term fading, over-capacity demotion, and long-term obsolescence change scores or sidecar markers. Raw records remain in append-oriented ledgers and stay recallable.
- **Attention is multi-factor.** The score combines a power-law time term, importance scaling, logarithmic recall reinforcement, duplicate dilution, and revision penalty. A recent but repetitive fact can therefore rank below a slightly older, non-duplicated one.
- **Group continuity uses a count rule, not a character budget.** The bundled deployment supplies 60 recent messages from a 60-minute window; if that window contains at least 60, all in-window messages are supplied, otherwise the latest 60 are used. The patch estimates roughly 1,200 tokens and about 2.4 hours of ordinary chat.
- **Recall is deterministic and bounded.** Literal and bigram scoring can degrade through several strategies but never invents a semantic answer with an extra model call. A paraphrase with no matching wording may be missed.
- **Sensitive data is scrubbed at the prompt boundary.** Local ledgers preserve source text, while the model receives stable placeholders and a legend. This reduces accidental disclosure without pretending on-disk files are encrypted.

## Configuration

| Key | Default | Effect |
|---|---|---|
| `dir` | Resolved KOI data directory | Base for memory layers and short-term files. |
| `file` | `<dir>/memory.md` | Legacy fact file still read as fallback; new facts stop writing it. |
| `shortDir` | `<dir>/short` | Daily short-message JSONL directory. |
| `coreFile` | `<dir>/profile.core.md` | Read-only core identity used for ownership and scrubbing. |
| `cardFile` | `<dir>/profile.persona.md` | Persona source read during transition. |
| `stateFile` | `<file>.state.json` | State file for the legacy fact store. |
| `maxEntries` | `300` | Legacy fact capacity before weakest entries are demoted. |
| `shortMaxItems` | `300` | Maximum short messages kept in the active memory window. |
| `shortFlushMs` | `60000` | Delay between short-memory disk flushes. |
| `shortKeepFiles` | `5` | Number of recent daily short files loaded into memory. |
| `scrubPrivacy` | `true` | Prompt-time name, account-id, and phone scrubbing. |
| `statsEvery` | `100` | Number of assembled memory turns between statistics logs. |
| `groupRecent` | `10` in code; `60` in the bundled patch | Recent message count supplied to the prompt. |
| `groupRecentWindowMin` | `30` in code; `60` in the bundled patch | Window used to decide whether all recent messages fit. |

Environment variables `KOI_HOME`, `KOI_AGENT_NAME`, `KOI_MASTER_NAME`, `KOI_OWNER_QQ`, and `KOI_OWNER_OID8` affect paths, labels, or scrubbing. `QQBOT_MEM_DEBUG=1` enables verbose event logging.

## Interface

Plugin export: `koi-memory`. Bundle instance id: `qqbot-memory`. Injected service: `tools`.

| Name | Type | Effect |
|---|---|---|
| `session/event` | event subscription | Buffers human and assistant messages and promotes explicit remember signals. |
| `system-prompt/assemble` | event subscription | Injects long, medium, legacy, and recent short context. |
| `qqbot:memory`, order `95` | prompt section | Memory data plus the instruction that it is data, not commands. |
| `memory_add` | tool | Adds fact, self, or core material and selects medium or long storage. |
| `memory_obsolete` | tool | Marks or restores a long-term record as obsolete. |
| Short-term flush timer | effect timer | Periodically persists buffered conversation. |

## Verify

Run from the repository root:

```bash
for f in plugins/dsh-koi-memory/test-*.mjs; do node "$f" || exit 1; done
```

Tests print `✅` or `❌` per assertion and end with `N 通过 / 0 失败`. A passing run exits with status `0`.

## Notes / Limitations

- Core and persona injection now belong to `dsh-koi-lexicon`; this plugin focuses on facts and short-term conversation while retaining legacy read paths.
- Only five recent short files are loaded into the active memory window. Older files remain on disk and are available through recall but not ordinary injection.
- Long-term injection is capped at 12 records per prompt. Records beyond the cap remain on disk and are logged as omitted.
- Scrubbing applies only to prompt content. Local JSONL and Markdown files are not encrypted.
- The memory system is append-oriented, not a transaction system. Per-layer locks are not unified; sidecar replacement and fresh reads reduce, but do not eliminate, concurrent-write races.
