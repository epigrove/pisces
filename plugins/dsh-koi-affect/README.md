# dsh-koi-affect

[中文](./README.zh-CN.md) | English

Maintains the agent's changing internal state: energy, named mood dimensions, time context, and a short-lived residue from recall.

## What it does

- Tracks a 0–100 energy value and gently moves it toward the target for the current time of day.
- Resets energy once per local day and supports `rest` actions for naps, sleep, or tidying up.
- Appends named mood dimensions with signed strength, reason, and an optional curve.
- Computes active dimensions separately, so “irritated” and “relieved” can coexist instead of cancelling into one score.
- Injects current time, time-slot tone, energy, the previous speaker, and active mood dimensions as a runtime context snapshot.
- Recalls old mood evidence and uses it only to color that recall response without writing a new persistent mood episode.

## Design rationale

- **This package owns current state, not social judgment.** Likes, dislikes, descriptions, and affinity belong to `dsh-koi-lexicon`. Keeping only present condition here prevents two prompt sections from assigning different values to the same relationship.
- **Mood is multidimensional and agent-authored.** A single 0–100 score erases mixed feelings; independent dimensions preserve simultaneous emotions. Input recording no longer guesses emotion from keywords. The agent calls `feel_dimension` when it actually judges an event to have affected its mood.
- **Values are computed from appended records.** `affect.json` and `mood-dims.json` keep timestamped evidence, and active mood is recalculated on demand. The default mood curve has a 36-hour half-life and reaches the display threshold in about 20 days.
- **Energy follows context instead of drifting permanently.** The value moves toward a time-of-day target and is clamped. This prevents a long chat from making the agent “tired forever” while preserving a lower late-night baseline.

## Configuration

| Key | Default | Effect |
| --- | --- | --- |
| `dir` | Resolved KOI data directory | Base for default affect and mood files. |
| `file` | `<dir>/affect.json` | Energy, daily state, and legacy affect fields. |
| `ownerOid` | `KOI_OWNER_OID8` or `owner000` | Id whose messages do not trigger affect scoring. |
| `moodDimsFile` | `<affect directory>/mood-dims.json` | Storage for named mood dimensions. |
| `lexiconFile` | `<dir>/lexicon.json` | People source used by `recall_mood`. |

## Interface

| Name | Type | Effect |
| --- | --- | --- |
| `koi-affect` | plugin id | Mount name exported by the package. |
| `tools` | injected service | Required for affect tools. |
| `session/event` | event subscription | Tracks the latest human speaker. |
| `system-prompt/assemble` | event subscription | Settles energy and residue, then adds the mood section. |
| `koi:mood` | runtime context snapshot | Current time, state, energy, speaker, and active dimensions. |
| `feel_dimension` | tool | Appends one named mood observation. |
| `rest` | tool | Applies nap, sleep, or tidy energy recovery. |
| `request_mood_tuning` | tool | Queues a request to change the default mood half-life. |
| `recall_mood` | tool | Recalls legacy affect events and V3 mood dimensions. |

## Verify

Run from the repository root:

```bash
node plugins/dsh-koi-affect/test-mood-dims.mjs
```

The test prints `✅` or `❌` per case and finishes with `N 通过 / 0 失败`. A passing run exits with status `0`.

## Notes / Limitations

- `request_mood_tuning` only appends to `pending-tuning.jsonl`; an operator must approve a change before it affects the active curve.
- The retired single-value mood may remain in old files for compatibility, but it is no longer written or injected.
- Legacy residue records are settled if present, but current `recall_mood` does not create a new persistent residue entry.
- Mood injection appends to `contexts`; an old host without that array falls back to an empty one.
