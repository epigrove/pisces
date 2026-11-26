# dsh-koi-guard

[中文](./README.zh-CN.md) | English

Enforces deterministic filesystem boundaries for the agent's read, search, and write tools.

## What it does

- Checks `read`, `glob`, and `grep` paths against an allowlist rooted under the agent data directory.
- Rejects explicit sensitive files such as `.env`, `.credentials.yaml`, `chat.jsonl`, and `chat.key`, plus session and storage directories.
- Resolves symlinks and `..` using filesystem semantics before deciding whether a path is inside an allowed root.
- Allows `write` and `edit` only under `<home>/workspace`.
- Rejects `apply_patch` completely because parsing targets from patch text is considered too fragile.
- Returns `GuardRejected` tool errors with a readable reason and hint.

## Design rationale

- **Only machine-decidable checks belong here.** The guard decides path containment, not whether Chinese prose means “send this file.” A send-confirmation regex was removed because each fix created another false positive or bypass. Semantic intent belongs in the model or a channel confirmation.
- **Search needs the same boundary as read.** `glob` and `grep` do not necessarily pass through `read`. Guarding only `read` would leave an easy path to secrets through a search pattern, so all three tools use the same path rule.
- **Literal paths are insufficient.** A path can traverse a symlink and then use `..` to escape the allowlist. The guard walks each segment, resolving existing symlinks before applying `..`, and checks both literal and resolved candidates.
- **Writes are narrower than reads and ambiguous context fails closed.** Reads may include selected profile and lexicon files; writes are restricted to the workspace, and `apply_patch` is denied. If the session working directory cannot be resolved, checks fall back to the base and may reject more paths than necessary.

## Configuration

| Key | Default | Effect |
| --- | --- | --- |
| `home` | `~/.koi` | Data-home root for relative allowlist entries and the writable workspace. |
| `base` | Parent directory of `home` | Base for relative tool paths when session cwd is unavailable. |
| `allow` | `workspace`, `profile.persona.md`, `profile.core.md`, `lexicon.json` | Read/search roots relative to `home`, or absolute roots. |

## Interface

| Name | Type | Effect |
| --- | --- | --- |
| `koi-guard` | plugin id | Mount name exported by the package. |
| `tools` | injected service | Required to subscribe to tool execution. |
| `tools/execute` | event subscription | Runs deterministic path rules before the next tool handler. |
| `fs` rule | internal rule | Checks `read`, `glob`, and `grep` paths. |
| `write` rule | internal rule | Checks `write` and `edit`; denies `apply_patch`. |
| `GuardRejected` | tool error | Reports the rejection reason and allowed scope. |

## Verify

Run from the repository root:

```bash
node plugins/dsh-koi-guard/test-guard.mjs
```

The test prints `✅` or `❌` per case and ends with `N 通过 / 0 失败`; success exits with status `0`.

## Notes / Limitations

- `bash` and unknown tools are not inspected by this guard.
- File-sending intent, prompt-injection text, and semantic “do not say this” instructions are outside its scope.
- Relative paths use the session working directory when the `workingDirectory` service is available; otherwise they fall back to `base`.
- The deny list is intentionally narrow and explicit. It is not a general secret scanner.
