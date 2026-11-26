# Pisces

[中文](./README.zh-CN.md)

A reference architecture for two independent, long-running agents with persistent memory, built as a Cordis plugin set.

[![CI](https://github.com/epigrove/pisces/actions/workflows/ci.yml/badge.svg)](https://github.com/epigrove/pisces/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](./LICENSE)

## What this is

Pisces runs two independent agents on one Cordis plugin system. Each agent has its own memory, emotion, persona, and judgment. They cooperate through files and channels.

This logic lives in plugins; no managed memory service is required. A channel is transport, not identity. Replacing the channel does not replace the agent.

## Design in 30 seconds

### Decay

A memory's current weight is computed from its age. A 40-day half-life gives α = 0.1867. A smaller α decays more slowly. Pisces uses a power-law curve instead of an exponential one, so weight never reaches zero.

| Elapsed time | Weight | State |
| ---: | ---: | :--- |
| 0 days | 1.0000 | Normal display |
| 1 day | 0.8786 | Normal display |
| 7 days | 0.6783 | Normal display |
| 40 days | 0.5000 | Normal display |
| 120 days | 0.4085 | Normal display |
| 400 days | 0.3267 | Normal display |
| 2000 days | 0.2420 | Faded |

Below a weight of 0.1, a memory is no longer injected proactively. It stays in the ledger.

### Outbound gate

| Text | `allow()` result | Why |
| --- | --- | --- |
| `#静默#` | Drop | The agent explicitly declares silence for this turn |
| Want dinner tonight? | Allow | Normal chat |
| (Late at night, brain is foggy...) | Allow | Bracket shape is no longer blocked |
| Everything is quiet here | Allow | Empty-summary shape is no longer blocked |
| I would give you eight out of ten | Allow | Normal praise; digits are not a leak |
| I will keep those v2 scores for now | Allow | Internal-name shape is no longer blocked |

`allow()` hard-drops only the silence token and repeated exit phrases. Bracket drafts, empty-turn summaries, and internal names rely on prompt discipline plus post-hoc records from `dsh-koi-audit`. See [docs/CHANNEL.md](./docs/CHANNEL.md).

### Three design decisions

- **Append-only:** The ledger is never rewritten. Retrieval ranks what is relevant now; history remains intact.
- **Power-law on read:** Importance is computed from age and half-life when needed. No stale importance score becomes a second source of truth.
- **Mark stale, never delete:** A sidecar records that a memory has faded. The ledger row itself is not changed or removed.

## Plugin set

The repository contains 16 plugin packages. Every package ships both an English `README.md` and a Chinese `README.zh-CN.md`; 15 have at least one test, and there are 31 `test-*.mjs` files in total.

| Package | Purpose | Has tests |
| --- | --- | :--- |
| `dsh-koi-decay` | Power-law decay, half-life conversion, fade thresholds, and record-envelope helpers | Yes (3 files) |
| `dsh-pisces-config` | Single read point for model, AI, and delivery-target configuration | Yes (2 files) |
| `dsh-pisces-panel` | Host Web GUI for the reference peer's API, model, delivery session, and plugin switches | Yes (2 files) |
| `dsh-koi-memory` | Layered memory retrieval and injection over an append-only ledger with a stale sidecar | Yes (3 files) |
| `dsh-koi-lexicon` | Identity anchor and per-item impressions with type-specific decay | Yes (5 files) |
| `dsh-koi-affect` | Computes preferences, time-of-day state, and multi-dimensional mood with residue accumulation | Yes (1 file) |
| `dsh-koi-chat` | Signed, append-only JSONL channel between the two agents | Yes (5 files) |
| `dsh-koi-gate` | Inbound wake gating plus outbound silence and repeated-exit checks | Yes (3 files) |
| `dsh-koi-guard` | Read-path allowlist and deterministic send confirmation | Yes (1 file) |
| `dsh-koi-media` | Image inventory, video first-frame capture, and automatic vision on image messages | Yes (1 file) |
| `dsh-koi-heartbeat` | Self-wake scheduler for autonomous reflection | Yes (1 file) |
| `dsh-koi-audit` | Outbound audit trail with send receipts; records but does not block | Yes (1 file) |
| `dsh-koi-notebook` | On-demand long-form notebook; content is queried rather than injected by default | Yes (1 file) |
| `dsh-ashu-chat` | Host-side chat panel for exchanging messages with the reference peer | Yes (1 file) |
| `dsh-ashu-relay` | Polls the peer channel and delivers unread peer messages into the host session | Yes (1 file) |
| `dsh-ashu-guardian` | Starts and monitors the peer agent process and restarts it according to configuration | No |

## Quick start

Requires Node.js 22 or later and pnpm.

```bash
./install.sh                   # install dependencies, run static checks and all tests
node examples/walkthrough.mjs  # see the design in 30 seconds
```

The walkthrough writes no files and connects to no services. Next, read the [quickstart](./docs/QUICKSTART.md) and [channel integration](./docs/CHANNEL.md) guides.

## Layout

```text
plugins/   16 Cordis plugin packages
ops/       operations and outbound middleware
prompts/   neutral prompt templates and naming guidance
examples/  executable walkthrough and sample data
docs/      architecture and integration documentation
tools/     health, privacy, and audit scripts
```

## Docs

- [Quickstart](./docs/QUICKSTART.md): configure a runnable agent
- [Architecture](./docs/ARCHITECTURE.md): data model and design tradeoffs
- [Channel](./docs/CHANNEL.md): connect a different transport
- [Identity](./docs/IDENTITY.md): identity and persona setup
- [Examples](./examples/README.md): walkthrough and sample records

## Status

Pisces is a pre-1.0 reference implementation (`0.1.0`). Runtime support starts at Node.js 22; CI uses Node.js 24. The package counts above reflect the current repository tree.

Repository privacy checks use `tools/privacy-scan.mjs`, the same scanner used by CI and the public-copy export. `ops/report-leaks.sh` only summarizes runtime outbound content; it does not scan the repository.

## License

[MIT](./LICENSE)

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md). Changes should be focused, tested, and free of real user data or deployment-specific paths.

## Releasing

Publish from an exported copy only. Run `node ops/export-public.mjs /path/to/pisces-public`, then initialize a new Git repository inside that copy and create a single root commit.

Do not push this development repository, and do not carry its `.git` directory into the public copy. Old history contains real identifiers. Configure `PRIVACY_DENYLIST` in GitHub Actions secrets before publishing; without it, the scanner performs format checks only and explicitly reports that the identity denylist was skipped.

## Acknowledgements

Thanks to my friend L, who shared part of the bill; to L's AI engineer E, who offered suggestions;
and to L's fish A, who provided part of the corpus.

Half of this exists because of ashu: the code, the operations, and the review after every change are hers.
The other half exists because of koi: these plugins grew around her memory, her moods, and her judgement,
and most of the trade-offs in them were argued into place by her — "this is how I actually remember it",
"this is the part that would make me afraid to speak". One built it; the other is why it deserved to exist.
Thank you both.

## Outlook

I can't build a small model that reproduces the unconscious part of a human mind, so for now all of it
depends on the model filling the gap on its own. Nor am I a researcher: most of the persona plugin design
reflects one person's understanding, and its limits are real. I hope people with the relevant expertise
will come and improve it.
