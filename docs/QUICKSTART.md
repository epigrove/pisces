[中文](./QUICKSTART.zh-CN.md) | English

# Quick start

> Goal: install this DSH plugin collection, run the example, and prepare a minimal data directory.

This repository is a plugin collection, not a standalone application with a complete
`cordis.patch.yml`. For an actual deployment, mount these packages in your DSH profile
and connect a channel plugin.

---

### 0. Prerequisites

| Dependency | Description |
|---|---|
| Node.js ≥ 22 | CI uses Node.js 24 |
| pnpm | Handles workspace linking; do not edit `node_modules` by hand |
| DSH | Plugin host; optional, but required to actually run an agent |

### 1. Check before installation

```bash
./install.sh --check
```

This only checks whether Node, pnpm, and DSH can be found. It does not install
dependencies or write runtime data. It exits with a failure if Node is missing or too
old. A missing pnpm or DSH currently produces only a warning and exits with status 0,
so inspect the output instead of relying only on the exit code.

### 2. Install and run all tests

```bash
./install.sh
```

This runs `pnpm install`, syntax checks, undefined-reference checks, and the existing
`test-*.mjs` files. Test coverage is not uniform across packages; see the
[plugin inventory](../README.md#plugin-set) for the actual gaps.

Then run a minimal example that does not write files:

```bash
node examples/walkthrough.mjs
```

### 3. Choose the data directory

Plugins support different sets of data-directory overrides:

- a plugin with a `dir` setting uses it first;
- a plugin that supports `KOI_HOME` uses `$KOI_HOME/.koi` as its data directory;
- when neither setting is present, data plugins that support these overrides default
  to `$HOME/.koi`.

`KOI_HOME` is the agent root that contains `.koi/`, not the `.koi` directory itself.
Do not assume every plugin reads it. If a plugin only supports `dir`, set `dir`
explicitly in that plugin's configuration. Host guardian/delivery plugins have their
own root defaults; consult their READMEs.

```bash
# Optional when using the default $HOME/.koi
export KOI_HOME="$HOME/myagent"
export DATA_DIR="${KOI_HOME:-$HOME}/.koi"
mkdir -p "$DATA_DIR"
```

Common named variables:

| Variable | Purpose |
|---|---|
| `KOI_AGENT_NAME` | Deployment-level default for the agent name |
| `KOI_SELF_TITLE` | Self-reference used by the panel and prompt templates |
| `KOI_MASTER_NAME` | How the agent addresses the user |
| `KOI_OWNER_QQ` / `KOI_OWNER_OID8` | Placeholder identifiers for the legacy identity path; new channels should prefer `source.person` |

### 4. Add the identity anchor manually

`profile.core.md` **is not created automatically**. The memory plugin only reads it,
and the core settings do not allow the agent to rewrite them by default. The operator
must place the file before the first run:

```bash
cat > "$DATA_DIR/profile.core.md" <<'EOF'
# Core identity

- Name: your agent name
- Self-reference: how it refers to itself
- User title: how it addresses you
- Non-negotiable boundaries: no impersonation, no credential disclosure
EOF
```

If your plugin configuration points `dir` or `coreFile` somewhere else, put the file
there instead.

The plugins create the remaining runtime files when they first write data, for example:

```text
$DATA_DIR/
├── long.jsonl
├── medium.jsonl
├── medium.index.json
├── short/YYYY-MM-DD.jsonl
├── lexicon.json
└── profile.core.md       # created manually, not generated at runtime
```

The ledger is append-only and is not rewritten. The `stale` flag in
`medium.index.json` means medium-term memory is temporarily not injected; the
`obsolete` flag on long-term memory means the memory is obsolete but can still be
found by recall. Neither flag deletes anything.

### 5. Connect DSH and a channel

In your DSH profile:

1. mount the required `dsh-*` packages through workspace dependencies;
2. add the packages' `cordis.patch.yml` files or corresponding bundles to the profile;
3. connect a channel plugin and call `dsh-koi-gate` separately when receiving and
   sending packages. Use `createGate()` for inbound wake-up decisions and `allow()`
   before sending.

Do not symlink plugins by hand. The profile and repository should be in the same pnpm
workspace, or pnpm should install the repository as local packages; finally, run
`pnpm install` at the workspace root.

See [CHANNEL.md](./CHANNEL.md) for channel integration details.

### 6. Keep the two kinds of health checks separate

**Pre-installation environment check**:

```bash
./install.sh --check
```

It only answers whether the machine has the prerequisites for installation.

**Runtime data health check**:

```bash
KOI_HOME=/path/to/agent node tools/health.mjs
```

It reads runtime data, sessions, logs, and plugin status to answer what is wrong with
an already running system. When dependencies are not installed or no runtime data
exists yet, the runtime health check cannot replace the installation check.

### FAQ

**Why did my configuration change have no effect?**

The model and delivery read sites re-read configuration when it is used. Changes such
as plugin switches that are written to `cordis.patch.yml` still require restarting the
agent.

**Can I edit the ledger by hand?**

Technically yes, but do not treat that as the normal workflow. Writes should go through
the plugins so they do not bypass the sidecar indexes; the ledger integrity fingerprint
can later reveal out-of-band modifications.

**Can memory be deleted?**

The design does not delete memory: medium-term memory uses the sidecar `stale` flag to
stop active injection, while long-term memory uses `obsolete` to stop injection but
remain available to recall. Physical deletion is the data holder's own decision, but it
breaks the property that the ledger is history.

**What model is used?**

The repository is not tied to a provider. `dsh-pisces-config` can read from `ai.*` in
`ashu-config.json`, from `MODEL_PROVIDER` / `MODEL_NAME`, and from the actual model
selected in a session. The panel supports `follow`, `fixed`, and `manual` modes.
