# dsh-pisces-config

[中文](./README.zh-CN.md) | English

The shared read-side contract for Pisces data location, AI configuration, session selection, and channel-neutral identity.

## What it does

- Resolves the single koi data directory from an explicit directory, `KOI_HOME`, or the home directory.
- Reads provider and model overrides by purpose: `chat`, `vision`, `gate`, and `iterate`.
- Resolves a model from a fixed configuration, live session selection events, or an explicit fallback.
- Selects a delivery session with a pinned id, human activity, and sub-agent filtering.
- Normalizes `source.person` identities into platform-scoped keys and detects configured owners.
- Provides one legacy text extractor for unmigrated QQ-formatted messages.

## Design rationale

AI configuration and delivery targeting are both configuration decisions, but their readers must agree on where configuration lives. Identity parsing is coupled to the same data-directory rule because identity-aware plugins otherwise resolve paths independently and can read different `.koi` directories. Keeping identity resolution and data-directory resolution in one package gives all consumers one path contract, one identity shape, and one owner-key format. Splitting them across packages only spreads “configuration” across more code while preserving the same coupling.

The terminal identity shape is `source.person = { platform, id, name?, scope? }`. The stable key is `platform:id`, lowercased on both sides. Names are display-only, and platform ids are treated as opaque strings. QQ-specific text scraping remains available only as a marked legacy fallback.

For model choice, a fixed panel selection wins when both provider and model are present; otherwise the reader follows the latest `model/selection` event from a live main session and finally uses the caller's fallback. Hardcoding a provider was rejected because stale configuration prevents sessions from being created.

For delivery, the order is pinned session, the main session where a human last spoke, then the most recently active candidate. The exported `isHumanSource()` is fail-closed and accepts only `source.kind === "user"`, which keeps runtime context, schedules, compaction records, and relay injections out of identity-sensitive processing. The current `lastHumanAt()` selector uses the allowlist for defined kinds but also accepts messages with no source kind for legacy compatibility. The package must be reread at delivery time rather than cached at startup; otherwise panel changes appear to lose messages.

The cost is filesystem-backed configuration reads, no schema-migration layer, and a strict sender model that can reject malformed source data. Consumers must provide live agent event APIs for the selectors.

## Configuration

| Key | Default | Purpose |
|---|---|---|
| `dir` | unset | Exact koi data directory; highest-priority path override. |
| `koiHome` | `$KOI_HOME` | Base directory to which `.koi` is appended. |
| `home` | `$HOME` or the OS home directory | Final base directory to which `.koi` is appended. |
| `ai.chat.provider`, `ai.chat.model` | empty; then `MODEL_PROVIDER`, `MODEL_NAME` | Main-chat AI selection and fallback for other purposes. |
| `ai.vision.provider`, `ai.vision.model` | fall back to `ai.chat`, then environment | Vision AI selection. |
| `ai.gate.provider`, `ai.gate.model` | fall back to `ai.chat`, then environment | Gate/evaluation AI selection. |
| `ai.iterate.provider`, `ai.iterate.model` | fall back to `ai.chat`, then environment | Iteration/proposal AI selection. |
| `api.mode` | `follow` | `fixed` uses `api.provider` and `api.model` in `koiModel`; every other value follows live sessions. |
| `api.provider`, `api.model` | empty | Fixed model pair, used only when `api.mode` is `fixed`. |
| `sessionId` | empty | Optional pin passed to `pickAgent`. |

## Interface

- Exports the library surface from `ai-config.mjs` and `identity.mjs`; it has no bundle plugin id, HTTP routes, tools, or events.
- Model/session exports: `resolveKoiDataDir`, `aiConfig`, `lastModelOf`, `pickModel`, `koiModel`, `isSubAgent`, `idOf`, `isHumanSource`, `humanKindOf`, `lastHumanAt`, and `pickAgent`.
- Identity exports: `personOf`, `personKeyOf`, `personNameOf`, `isOwnerPerson`, and `legacyKeyFromText`.
- No injected services. `aiConfig()` reads `<dataDir>/ashu-config.json`; selection functions consume caller-supplied agents and override objects.

## Verify

```bash
cd <repo>
node plugins/dsh-pisces-config/test-config.mjs
node plugins/dsh-pisces-config/test-identity.mjs
```

Expected: both commands exit 0; all 31 configuration checks and all 22 identity checks pass.

## Notes / Limitations

- A malformed or unreadable `ashu-config.json` makes `aiConfig()` log and fall back to empty/configured sources; it does not validate or migrate the file.
- `pickModel` can return empty provider/model strings when no session event or fallback exists.
- `lastHumanAt` accepts a `user/message` with no source kind for legacy compatibility; only `isHumanSource` has the strict fail-closed `kind === "user"` check.
- The legacy extractor recognizes only the historical bracketed 32-character hexadecimal QQ format after `[Current message]`.
- This package reads configuration; it does not provide the GUI writer or perform revision checks.
