# dsh-ashu-guardian

[中文](./README.zh-CN.md) | English

The host-side process guardian that can launch the peer agent, inspect it on a timer, and optionally synchronize API configuration before a relaunch.

## What it does

- Checks for a live peer process matching Node plus `dsh --profile koi`.
- Uses a deploy-provided `script --daemon` launcher when `adopt` is enabled and no peer is present.
- Runs an optional API synchronization script before allowing a relaunch.
- Keeps periodic health inspection independent from API synchronization, so a missing or failed sync does not disable monitoring.
- Clamps the inspection interval, applies a 15-second launch cooldown, and avoids duplicate launches when `pgrep` itself fails.
- Preserves the peer on plugin disposal by default; `killOnDispose` can terminate only the launcher child.

## Design rationale

The deployment fact is that a peer left inside the `dsh-web` cgroup is torn down with `dsh-web`. A process owned as a normal child of the host therefore does not solve the lifecycle problem. The plugin invokes `spawn('/bin/bash', [script, '--daemon'], { instrument: false })`; the launcher is expected to detach the real peer with `nohup setsid`. The short launcher must exit, and `instrument: false` prevents that exit from being treated as the host unit exiting.

Every inspection round checks whether the peer exists, regardless of the API-sync result. Synchronization may run and be reported, but its result only gates the launch decision. A failed sync with `allowStale: false` leaves the peer down instead of silently starting it with the wrong provider, model, or credentials. This separation was necessary because the default deployment leaves `syncScript` empty; treating “not configured” as “failed” previously stopped inspection altogether.

The guardian uses `pgrep -af` and then validates the full command line. A non-1 `pgrep` error is treated as unknown, not as “no process,” because a false absence would start a second peer and make two peers compete for the same channel.

Direct systemd supervision was rejected after the peer's `spill-local` failed with a read-only `/tmp` error under systemd's mount namespace. Directly spawning a detached foreground `dsh` was also rejected because it still shares the host sandbox and can cause the unit to recycle its own namespace. The cost is an external launcher contract: the configured script must validate its environment, daemonize the peer, and exit successfully.

## Configuration

| Key | Default | Purpose |
|---|---|---|
| `enabled` | `true` | Disable all guardian behavior when set to `false`. |
| `script` | `${KOI_HOME}/ops/start.sh` when omitted; the bundle sets it to `''` | Launcher invoked as `script --daemon`. An empty value disables adoption. |
| `cwd` | `$KOI_WORKDIR`, then `$HOME/workspace` | Working directory for the launcher. |
| `intervalMs` | `60000` | Health-check interval in milliseconds, clamped to 15,000–3,600,000. |
| `adopt` | `true` | Launch the peer when it is absent; forced off when `script` is empty. |
| `syncScript` | `''` | Node script attempted on each inspection; its result gates launch. Empty means synchronization is not configured. |
| `killOnDispose` | `false` | Send `SIGTERM` to the direct launcher child when the plugin is disposed. |
| `allowStale` | `false` | Permit launch after a configured synchronization failure. |

`KOI_HOME` and `KOI_WORKDIR` supply the defaults above. The peer profile name in the process pattern is currently the fixed value `koi`.

## Interface

- Package id: `dsh-ashu-guardian`; bundle entry and runtime plugin id: `ashu-guardian`.
- No HTTP routes, tools, or event registrations.
- Services injected: none.
- External dependencies: `pgrep`, `/bin/bash`, the configured launcher, and the optional synchronization script.

## Verify

```bash
cd <repo>
node --check plugins/dsh-ashu-guardian/lib/index.js
node -e "import('./plugins/dsh-ashu-guardian/lib/index.js').then(m => console.log(m.name, typeof m.apply))"
```

Expected: both commands exit 0, and the second prints `ashu-guardian function`.

## Notes / Limitations

- This package has no automated test suite.
- It relies on the host process table; if `pgrep` is unavailable or errors, it skips that round.
- The process pattern is fixed and targets the `koi` profile.
- `killOnDispose` targets only the launcher child. A properly daemonized peer is expected to outlive the launcher.
- Logs intentionally use `console.log` with the `[ashu-guardian]` prefix so they remain visible in deployment logs.
