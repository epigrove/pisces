# Changelog

[中文](./CHANGELOG.zh-CN.md) | English

Important changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/), and versions follow semantic
versioning.

## [0.1.0] - 2026-11-26

Initial open-source reference release, with the following major capabilities:

- 16 DSH plugin packages covering dual-agent memory, emotion, impressions,
  conversation, gating, media, audit, notebooks, and host guardianship.
- Four-layer memory uses an append-only ledger, power-law decay, and sidecar
  markers. Medium-term entries use `stale`, long-term entries use `obsolete`,
  and original text is never physically deleted.
- `rules`, `says`, and `selftalk` were merged into `dsh-koi-gate`. Outbound
  content is no longer blocked based on the shape of brackets or internal
  words; the design now relies on prompt self-discipline and post-hoc audit.
- Added structured identity through `source.person` with a legacy fallback.
  Outbound audit now checks image descriptions, traces quoted text, and records
  misattribution.
- Completed pre-release hardening: filled in plugin metadata, added CI privacy
  and path scans, aligned examples and documentation, and fixed public-copy
  installation and false-green test failures.
