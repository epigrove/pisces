# dsh-pisces-panel

[中文](./README.zh-CN.md) | English

The host-side web GUI for editing the peer agent's model, delivery, naming, credential, and plugin-switch configuration.

## What it does

- Registers **Pisces Config** in the host sidebar.
- Exposes current API/model state, available providers/models, live main sessions, and the peer plugin catalog.
- Merges `api`, `proposal`, `defaults`, `naming`, and `ai` sections into `<KOI_HOME>/.koi/ashu-config.json`.
- Writes provider credentials without echoing them to the browser.
- Scans package metadata and bundle patches to list toggleable plugins and dependencies, then edits `disabled` in the peer patch with a SHA-256 revision check.
- Displays the identity file path read-only.

## Design rationale

The canonical read-side contract for model and delivery semantics is **`dsh-pisces-config`**. The panel is the GUI writer for the same `ashu-config.json` format and does not create a second on-disk configuration model. A fixed model is written only to the peer's override, never to a shared model environment file, because changing the shared value would also change the host agent.

Writes that mutate shared profile text require revision conflict detection. `GET /pisces/plugins` returns a SHA-256 revision of the current patch; `POST /pisces/plugins/toggle` sends that revision and returns HTTP 409 with the current revision when the file changed. This prevents two stale browser tabs from silently overwriting each other's plugin state. The current `POST /pisces/override` route merges sections without a revision token, so it does not yet provide the same compare-and-swap guarantee for `ashu-config.json`.

Plugin entries are discovered from disk instead of hardcoded in the UI: categories come from package `dsh.pisces` metadata, ids from the package's bundle patch, and dependencies from package metadata reduced to the peer's bundle closure. This keeps the panel useful as plugins are added, while avoiding fake switches for host-only packages copied into the same directory.

Credentials are scoped to the peer. The panel prefers the host credentials service only when the host and peer share the same DSH home; otherwise it atomically updates the peer's `.credentials.yaml`. A malformed credential file is backed up and writes are refused. The cost is that changing a plugin switch requires a peer restart, and edits are eventually reflected rather than hot-reloaded.

## Configuration

| Key | Default | Purpose |
|---|---|---|
| `koiHome` | `$KOI_HOME`, then `$HOME/koi` | Peer root containing `.koi`, `.dsh-home`, and `plugins`. |
| `sharedModelEnv` | `$PISCES_SHARED_MODEL_ENV`, then empty | Optional shared model environment file used as the live-model fallback. |

The panel also uses `DSH_HOME` when deciding whether the credentials service can write the peer's credentials. Naming fallbacks read `KOI_AGENT_NAME`, `KOI_SELF_TITLE`, `QQBOT_ALIASES`, `KOI_MASTER_NAME`, `KOI_OWNER_OID8`, and `KOI_OWNER_QQ`; persisted naming values in the override take precedence.

## Interface

- Package id: `dsh-pisces-panel`.
- Bundle entry id: `pisces-config-config`; runtime plugin name: `pisces-config`.
- HTTP routes:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/pisces/state` | Return effective API/override state, live model, identity path, naming, and defaults. |
| `GET` | `/pisces/models` | Return providers/models parsed from the peer's `llm-providers.yml`, including key-presence flags only. |
| `POST` | `/pisces/key` | Write `{ env, value }` to the peer credential store. |
| `GET` | `/pisces/sessions` | List non-sub-agent host sessions with the last human activity time. |
| `GET` | `/pisces/plugins` | List the peer plugin closure with metadata, dependencies, revision, and toggle state. |
| `POST` | `/pisces/plugins/toggle` | Write `{ id, enabled, revision }` into the peer patch and return `needRestart: true`. |
| `POST` | `/pisces/override` | Merge writable configuration sections into `ashu-config.json`. |

- Registers no tools or host events.
- Services: requires `webServer`; optionally uses `agents` for sessions/models and `credentials` when host and peer share a DSH home.

## Verify

```bash
cd <repo>
node plugins/dsh-pisces-panel/test-regressions.mjs
node plugins/dsh-pisces-panel/test-contract-audit.mjs
```

Expected: both commands exit 0; all 2 regression checks and all 5 contract-audit checks pass.

## Notes / Limitations

- `/pisces/override` currently has no revision/CAS token; concurrent writers can race between its read and atomic rename.
- Plugin toggle writes use revision conflict detection and return HTTP 409 on mismatch.
- Plugin changes require a peer restart; the panel does not hot-reload the running peer.
- The identity file is shown as a server-side path and is not editable here.
- The backend currently keeps local copies of model/session selection helpers; `dsh-pisces-config` remains the shared semantic contract.
- The panel lists only peer packages in the profile's dependency/bundle closure and treats packages without a bundle plugin id as non-toggleable libraries.
- Its local `lastHumanAt` helper accepts a `user/message` with no source kind for legacy compatibility.
