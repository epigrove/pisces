# dsh-koi-heartbeat

[中文](./README.zh-CN.md) | English

Schedules the agent's self-initiated wake-ups and starts each one as a complete agent turn.

## What it does

- Lets the agent choose a qualitative next-wake preset: soon, later, afternoon, tonight, or tomorrow.
- Converts the preset into a concrete timestamp and clamps ordinary presets to configured minimum and maximum gaps.
- Enforces a rolling 24-hour wake cap with an optional night allowance.
- Injects a heartbeat through `agent.followup()` so the full agent stack runs, using a watchdog and fallback scheduling to recover missed timers.
- Exposes tools to schedule the next wake and inspect the current schedule and recent wake count.
- Optionally runs a periodic external report with an explicit enable switch, deadline, and output path.

## Design rationale

- **Qualitative choices make the schedule expressive without making it exact.** “Soon” and “tonight” communicate intent better than a raw minute count. The plugin maps them to times and then clamps them, preventing the agent from avoiding the minimum-gap policy by choosing “five minutes from now.”
- **Hard quotas protect cost and attention.** Every wake is a full model turn. A rolling timestamp window and hard cap are more reliable than trusting the agent to remain economical; night mode changes cadence but does not remove the ceiling.
- **Wake-up must be a real turn.** Calling a bare LLM would omit persona, memory, current mood, and tools. `followup()` enters the normal agent loop, so the agent can think, summarize, contact the operator, inspect a group, or do nothing.
- **Scheduling is defensive and idle behavior backs off.** A missing `heartbeat_next`, an exception, sleep/resume, or a lost timer can otherwise leave the heartbeat dead indefinitely. A post-wake fallback and watchdog restore a future schedule, while repeated short idle wakes move toward longer presets. With no live session, the default is to skip and reschedule; `allowSolo` is required to create a dedicated session.

## Configuration

| Key | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` | Disable the plugin when `false`. |
| `minGapMinutes` | `90` | Minimum gap for ordinary presets. |
| `maxGapMinutes` | `900` | Maximum gap for ordinary presets. |
| `dailyCap` | `8` | Rolling 24-hour wake cap. |
| `nightStartHour` | `22` | Start of night allowance. |
| `nightEndHour` | `8` | End of night allowance. |
| `nightIntervalFactor` | `1.25` | Multiplier applied to night gaps. |
| `nightExtraCap` | `2` | Additional night wake allowance. |
| `ownerName` | `主人` | Owner label used in the heartbeat prompt. |
| `dir` | `~/.koi` | State and heartbeat log directory. |
| `workspaceDir` | `~/.dsh-qqbot/workspace` | Working directory for a self-created solo session. |
| `provider` | Empty | Explicit provider for a self-created session. |
| `model` | Empty | Explicit model for a self-created session. |
| `allowSolo` | `false` | Permit creation of a dedicated heartbeat session when no live agent exists. |
| `maxTokens` | `700` | Compatibility key parsed by the plugin; current code does not pass it to `followup()`. |
| `debug` | `true` | Emit detailed scheduling diagnostics. |
| `leakReport.enabled` | `false` | Enable the optional periodic report. |
| `leakReport.script` | `tools/leak-check.mjs` | Report script path relative to repository root. |
| `leakReport.output` | `ops/leak-weekly.log` | Append-only report output path. |
| `leakReport.everyMs` | `604800000` | Minimum interval between reports. |
| `leakReport.until` | No deadline | ISO deadline after which the report timer stops. |
| `leakReport.args` | `[]` | Arguments passed to the report script. |

## Interface

| Name | Type | Effect |
| --- | --- | --- |
| `koi-heartbeat` | plugin id | Mount name exported by the package. |
| `agents`, `tools` | injected services | Required for follow-up turns and heartbeat tools. |
| `heartbeat_next` | tool | Schedules the next wake from a qualitative preset. |
| `heartbeat_status` | tool | Reports the next wake and rolling 24-hour count. |
| `agent.followup()` | host call | Starts a complete heartbeat turn. |
| timer, post-wake fallback, watchdog | timers | Trigger, repair, or recover wake scheduling. |
| `heartbeat.json`, `heartbeat.log.jsonl` | state files | Persist schedule state and append wake/plan logs. |

## Verify

Run from the repository root:

```bash
node plugins/dsh-koi-heartbeat/test-heartbeat-regressions.mjs
```

The test prints `✅` or `❌` per assertion and ends with `N 通过 / 0 失败`; success exits with status `0`.

## Notes / Limitations

- Timers live inside the agent process. The watchdog repairs missed in-process timers, not a process that is not running.
- The rolling cap is based on stored wake timestamps, not a local calendar-day counter.
- With `allowSolo: false`, the plugin never creates a separate agent just to keep the heartbeat alive.
- An explicitly configured provider and model win; otherwise a self-created session inherits the panel fixed route or a live session. If none exists, the wake is skipped.
- A synchronous `followup()` failure does not consume wake quota.
- `maxTokens` currently has no runtime effect; heartbeat generation budget is not controlled by this key.
