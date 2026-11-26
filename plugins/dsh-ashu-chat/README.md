# dsh-ashu-chat

[中文](./README.zh-CN.md) | English

The host-side Pisces Chat panel: one direct, signed JSONL conversation line between the owner and the peer agent.

## What it does

- Registers the **Pisces Chat** sidebar entry and its `/pisces-chat/*` backend routes.
- Reads the last 80 messages addressed only from `master` to `koi` or from `koi` to `master`.
- Appends owner messages to `<KOI_HOME>/.koi/chat.jsonl` through the shared `chat-store`, marking them `via: "panel"` and signing them when `chat.key` is available.
- Accepts uploads up to 20 MiB, stores them under `.koi/workspace/uploads`, and appends a message containing the file metadata.
- Serves files only from the `.koi/workspace` subtree and reports unreadable records as a degraded state instead of pretending the channel is empty.

## Design rationale

The panel separates the owner-to-peer line from the other agent-to-agent line. It consequently requires an explicit `to` field for both directions; otherwise a message written as `from: "master"` without a recipient could appear as an owner message in the wrong conversation.

It does not manage or delete sessions. Session creation belongs to the chat layer, and hard-creating or deleting sessions would damage runtime data. The panel only displays the shared file channel and appends messages to it.

The signature establishes that a message came from this machine, not which person typed it: the owner and the local agent can use the same key. `via: "panel"` adds provenance, while actual user identity remains the responsibility of web authentication.

The 20 MiB upload limit is enforced during streaming in `readBody`. The request reader counts each chunk, fails with HTTP 413 before concatenating an oversized body, and allows for base64 expansion in the request cap. The decoded byte size is checked again before writing. Buffer-first validation and trusting only the browser-side `File.size` check were rejected because either permits avoidable memory use or bypasses the server.

The cost is base64 overhead and a fixed 20 MiB ceiling. Downloads are served as `application/octet-stream`, and the panel deliberately offers no message deletion or session management.

## Configuration

| Key | Default | Purpose |
|---|---|---|
| `koiHome` | `$KOI_HOME`, then `$HOME/koi` | Root containing `.koi/chat.jsonl`, `.koi/chat.key`, and `.koi/workspace`. |

## Interface

- Package id: `dsh-ashu-chat`.
- Bundle entry id: `ashu-chat-config`; runtime plugin name: `ashu-chat`.
- HTTP routes:

| Method | Route | Purpose |
|---|---|---|
| `GET` | `/pisces-chat/state` | Return recent messages, chat-file path, malformed-line count, and read status. |
| `POST` | `/pisces-chat/upload` | Accept `{ name, data, text? }`, save a file, and append a message. |
| `GET` | `/pisces-chat/file?rel=...` | Download a file under `.koi/workspace`. |
| `POST` | `/pisces-chat/send` | Append `{ text, kind? }` as a signed `master` to `koi` message. |

- Registers no tools or host events.
- Services: requires `webServer`; reuses the `dsh-koi-chat` signing and chat-store modules.

## Verify

```bash
cd <repo>
node plugins/dsh-ashu-chat/test-append.mjs
```

Expected: exit code 0 with all six checks passing.

## Notes / Limitations

- The display window is the latest 80 messages; older valid messages remain in the JSONL file.
- The browser polls `/pisces-chat/state` every five seconds because this channel has no push transport.
- The panel performs no session creation, deletion, or attachment cleanup.
- The file route confines paths to the workspace subtree by path prefix; it does not content-scan uploaded files.
- A missing key or signing error degrades to an unsigned message and is logged; it does not block delivery.
