# dsh-koi-lexicon

[中文](./README.zh-CN.md) | English

Maintains identity anchors and subjective records about people, things, events, and the agent's own later commitments.

## What it does

- Migrates legacy persona and affect data into one `lexicon.json` store once, without modifying the source files.
- Stores read-only core identity, self-authored additions, people by stable id or name, and things/events by normalized text.
- Appends V3 `desc` and `impression` items and computes their current values from per-item curves.
- Injects the current speaker and subjective world at orders `92` and `93`.
- Exposes tools for descriptions, impressions, reset, recall, status, and setting self-authored entries aside.
- Tracks same-day mentions and lets mentioned people surface without changing their score.

## Design rationale

- **One owner for conflicting social state.** Persona cards and affect records previously described the same person in different prompt sections and could inject contradictory claims. One state model makes "what this person is like" and "how I currently feel" read consistently.
- **V3 separates description from impression.** A description says what someone or something is like. An impression is a short `face` plus a signed `delta`. They have independent records, so an impression does not disappear merely because the latest description faded.
- **Descriptions have three presentation states, and fading is not deletion.** `clear` shows full descriptions, `fading` falls back to a concrete hook, and `forgotten` keeps only the hook or asks for recall. The hook is the highest-weight original description, not a generated summary. Display thresholds decide what is injected; lower-ranked records remain available through recall.
- **The code does not classify meaning for the agent.** The 2026-11-26 `A` decision was to keep one default curve and let the agent choose person versus thing and description versus impression when writing. `item.type` is a storage label, not a semantic classifier; V3 entries share one 40-day half-life default, and relationship limits can tighten an explicitly requested curve.
- **Prototype keys are untrusted input.** Tool arguments are model-controlled, so names such as `__proto__`, `prototype`, and `constructor` are rejected. `people` and `things` use null-prototype maps with own-key access, preventing arbitrary keys from polluting `Object.prototype`.
- **Repeated evidence combines by union probability.** Multiple impressions with the same face saturate rather than exceeding one. This distinguishes many weak observations from one extreme observation without hard truncation.
- **Relationship levels limit abuse.** The active relation check distinguishes strangers from known people, with a 14-day versus 60-day maximum half-life span. Parameters are clamped before writing, so one hostile message from a stranger cannot create a year-long grudge. Owner/self presets remain in the clamp table, but the current `relationOf()` path selects only stranger or known.
- **Migration and corruption fail visibly.** Legacy sources are read once and left untouched. A corrupt `lexicon.json` is backed up and write-blocked; normal writes re-read, then use a temporary file, fsync, and rename.

## Configuration

| Key | Default | Effect |
|---|---|---|
| `dir` | Resolved KOI data directory | Base directory for lexicon data and default files. |
| `platform` | `unknown` | Platform label stored in V3 identity metadata. |
| `selfName` | Empty | Additional name treated as the agent itself. |
| `cardFile` | `<dir>/profile.persona.md` | Legacy persona source used by one-time migration. |
| `coreFile` | `<dir>/profile.core.md` | Read-only core identity shown before the lexicon. |
| `maxPeople` | `40` | Maximum people rendered into the main V3 section. |
| `maxThings` | `40` | Maximum thing/event entries rendered in V3 output. |
| `descPerPerson` | `2` | Maximum clear descriptions rendered per person. |
| `migrateFromAffect` | `true` | Whether legacy likes, dislikes, and people are migrated once. |
| `useV3` | `false` in code; `true` in the bundled patch | Selects V3 item rendering instead of the legacy traits/history path. |

`KOI_AGENT_NAME` may add another self name.

## Interface

Plugin id: `koi-lexicon`. Injected service: `tools`.

| Name | Type | Effect |
|---|---|---|
| `agent/inbox/claimed` | event subscription | Updates the current speaker before prompt assembly. |
| `session/event` | event subscription | Records human speakers, turn counts, and same-day mentions. |
| `system-prompt/assemble` | event subscription | Adds speaker and subjective-world sections. |
| `koi:speaker`, order `92` | prompt section | Short-lived current-speaker evidence. |
| `koi:lexicon`, order `93` | prompt section | Core, self additions, people, likes, dislikes, and mood records. |
| `remember_person` | tool | Appends a person description. |
| `remember_impression` | tool | Appends or resets a person/thing impression. |
| `set_aside` | tool | Hides or restores a self-authored entry without deletion. |
| `recall` | tool | Searches impressions, descriptions, facts, short messages, and archives. |
| `lexicon_status` | tool | Summarizes current attitudes toward people and things. |

## Verify

Run from the repository root:

```bash
for f in plugins/dsh-koi-lexicon/test-*.mjs; do node "$f" || exit 1; done
```

Tests print `✅` or `❌` per case and end with `N 通过 / 0 失败`. Exit status `0` means every selected test passed.

## Notes / Limitations

- With `useV3: false`, the legacy traits/history renderer is active. The bundled patch explicitly enables V3.
- `recall` uses literal token matching and requires all query terms to match; it is not semantic search.
- This package does not apply owner-id authorization. Ownership remains subjective context, and `ownerOid` in the bundled patch is not consumed by the current implementation.
- `memory_add(scope="self")` and `memory_add(scope="core")` write into `lexicon.json`; core additions never modify the read-only core file.
- The read-modify-write API has no cross-process lock. Atomic replacement prevents torn files, but concurrent writers resolve by the last completed write.
