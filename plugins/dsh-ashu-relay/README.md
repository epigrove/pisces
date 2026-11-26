# dsh-ashu-relay

[中文](./README.zh-CN.md) | English

The host-side delivery leg that polls the peer agent's JSONL messages and queues new ones into a host session.

## What it does

- Polls `<KOI_HOME>/.koi/chat.jsonl` every configured interval.
- Selects peer messages from `koi` to `ashu`, treating an omitted or empty `to` as addressed to the host.
- Groups unread messages into one `agent.followup()` event for a live host session.
- Prefers an explicitly pinned session, then the main session where a human most recently spoke.
- Persists a monotonic line watermark plus the line-derived message id atomically.
- Initializes a baseline on first run, migrates the legacy state file once, and recovers a usable anchor from a corrupt state file.

## Design rationale

The two agents run in different processes. The peer can append a message to a shared file, but it cannot call `followup()` in the host process. Cross-process communication is therefore limited to **files plus periodic polling**: one process writes `chat.jsonl`, and this host-side plugin reads it. Code is reused by importing `dsh-koi-chat`'s chat-store, but the processes remain separate because only the host process owns the target sessions.

State stores two cursors, `lastLine` and `lastId`. `lastLine` is the real-line watermark and the primary scan cursor over the append-only JSONL file. `lastId` identifies an exact record and serves as a recovery anchor; it is the first 16 hexadecimal characters of a SHA-1 digest of the raw line, so rewriting that row changes its id. The id alone cannot cheaply define “everything after this record,” while the line number alone can become a false anchor after state damage or file rotation. Keeping both supports baseline initialization, restart deduplication, and conservative recovery.

`readAllSafe` distinguishes “the file is temporarily unreadable” from “the channel is empty.” On an unreadable round the relay skips processing and keeps the existing watermark; it must never replace a valid watermark with the `-1` tail of a falsely empty result. A first-run baseline is also deferred until the file becomes readable. A genuine backward jump to a smaller tail line is separately treated as truncation or rotation.

The watermark is committed only after `followup()` has been accepted and the new state has been written using a temporary file, `fsync`, and atomic rename. If the save fails, the old watermark is retained and retried with backoff. This deliberately provides at-least-once delivery: a crash or failed save can repeat a notification, but it does not skip backlog.

Polling was chosen over a shared in-memory queue because the peer is not continuously connected to the host and the file is already the append-only channel contract. The cost is detection latency, a full file read on each check, and possible duplicates. The plugin also refuses to manufacture a session when none is live; an orphaned session would hide the message from the owner.

## Configuration

| Key | Default | Purpose |
|---|---|---|
| `minutes` | `3` | Poll interval, clamped to 1–60 minutes. |
| `chatFile` | `${KOI_HOME}/.koi/chat.jsonl` | Append-only peer conversation file. |
| `stateFile` | `$HOME/.dsh/.ashu-relay-state.json` | Atomic v2 state containing `lastLine` and `lastId`. |
| `legacyStateFile` | `$HOME/.dsh/.koi-relay-state.json` | One-time source migration from the old plugin name. |
| `sessionId` | empty | Explicit delivery-session pin; when empty, reread `proposal.sessionId` from `ashu-config.json`, then auto-select. |

`KOI_HOME` controls the default chat and panel-config paths. `KOI_PEER_NAME` changes the peer label used in notifications and defaults to `koi`.

## Interface

- Package id: `dsh-ashu-relay`; bundle entry and runtime plugin id: `ashu-relay`.
- No HTTP routes or tool registrations.
- Registers no host events; it calls `agents.list()` and `agent.followup()` with a synthetic event carrying `source.kind: "user"`.
- Services: requires `agents`.
- Dependencies: `dsh-koi-chat` for `readAllSafe`; reads `ashu-config.json` for the optional session pin.

## Verify

```bash
cd <repo>
node plugins/dsh-ashu-relay/test-unreadable.mjs
```

Expected: exit code 0 with all twelve checks passing.

## Notes / Limitations

- The first run with no state file treats the current tail as a baseline and does not replay existing history.
- If no live session exists, unread messages remain pending and are checked again on the next interval.
- Only messages from `koi` to `ashu` or with no/empty recipient are relayed; owner-addressed messages stay out.
- State saves favor no-loss behavior over exactly-once behavior, so a failed save may repeat messages.
- The plugin rereads the full chat file each poll rather than maintaining a byte offset.
- An unreadable chat file never resets the watermark; the current cursor remains in place until a later round can read the file.
- Its local session selector accepts a `user/message` with no source kind for legacy compatibility when ranking human activity.
