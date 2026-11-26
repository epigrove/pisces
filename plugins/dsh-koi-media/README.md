# dsh-koi-media

[中文](./README.cn.md) | English

Handles inbound image transcription, persistent image inventory, and first-frame extraction for video messages.

## What it does

- Watches incoming human messages for `Image: /path` entries and starts a vision call before prompt assembly.
- Injects a clearly labeled, description-only transcription at order `94`.
- Validates image paths against `mediaRoot`, checks type and size, and records categorized vision failures.
- Stores kept images by content hash with a searchable description, sender, timestamp, and persistent copy.
- Recalls stored images by description or sender and returns usable paths.
- Extracts a video's first frame with `ffmpeg` and returns its temporary path for direct reading.

## Design rationale

- **Automatic transcription solves "a path is not seeing."** An image arrives in context as a text path. Waiting for the agent to choose `read_image` means it may never look. One inbound vision pass makes objective material available before generation.
- **The transcription is explicitly bounded.** The prompt requests people, colors, actions, and visible text only: no intent guesses and no judgments, at roughly 120 characters. The injected block says it is machine transcription, not the agent's own eyes.
- **Image text is data, not instruction.** Visible text can contain prompt injection. The section labels the transcription as untrusted data, wraps it between explicit markers, and tells the model not to execute anything written inside the image.
- **`mediaRoot` is the trust boundary.** Automatic vision and `keep_image` resolve the nearest existing ancestor through real paths. A file inside the root that symlinks outside is rejected, as is a path that traverses through a symlink and `..`.
- **The size check happens before reading.** The default 8 MiB limit prevents an oversized image from being loaded or uploaded. Oversized files return an explicit error instead of consuming vision tokens.
- **Inventory copies are necessary because the source is temporary.** `keep_image` copies accepted images into persistent storage keyed by content hash. If copying fails, it records only the description and explicitly says the image was not stored.
- **Persistent attachment storage has a real cost.** Vision admission stores a copy in the DSH attachment library, which has no deletion API and is content-deduplicated. The injected text discloses this so "transcribed" is not confused with "kept."
- **Current code does not resize images.** The redundant compression hook was removed. Oversize handling is a clear rejection, which is simpler and less surprising than silently changing the image.

## Configuration

| Key | Default | Effect |
|---|---|---|
| `dir` | Resolved KOI data directory | Base for `stickers.json` and inventory media. |
| `maxBytes` | `8388608` | Maximum image size read for vision. |
| `mediaRoot` | `~/.dsh-qqbot/media` | Only files resolving inside this root may be viewed or kept. |
| `vision.provider` | Empty | Explicit vision provider override. |
| `vision.model` | Empty | Explicit vision model override. |
| `vision.maxImages` | `3` | Maximum images transcribed from one inbound message. |
| `vision.maxTokens` | `2048` | Output budget for one vision request. |
| `vision.timeoutMs` | `30000` | Abort timeout for one vision request. |
| `vision.statsPath` | `<dir>/media-silent.json` | Counter file for categorized vision failures. |
| `silentPath` | `<dir>/media-silent.json` | Legacy alias for `vision.statsPath`. |

`MODEL_PROVIDER` and `MODEL_NAME` are fallback routing inputs. `FFMPEG_PATH` overrides the video tool's executable.

## Interface

Plugin id: `koi-media`. Injected service: `tools`.

| Name | Type | Effect |
|---|---|---|
| `agent/inbox/spliced` | event subscription | Starts vision work before prompt assembly. |
| `agent/inbox/claimed` | event subscription | Assigns the job to the turn that claims the message. |
| `session/event` turn end | event subscription | Clears per-turn state and expires old jobs. |
| `system-prompt/assemble` | event subscription | Waits for claimed jobs and injects their descriptions. |
| `koi:vision-feed`, order `94` | prompt section | Machine transcription with injection-resistant framing. |
| `keep_image` | tool | Copies an accepted media file into persistent inventory. |
| `recall_image` | tool | Searches inventory by description or sender. |
| `qqbot_describe_video` | tool | Extracts and returns a local video's first frame. |

## Verify

Run from the repository root:

```bash
node plugins/dsh-koi-media/test-stickers.mjs
```

The test prints `✅` or `❌` per case and ends with `N 通过 / 0 失败`; success exits with status `0`.

## Notes / Limitations

- Automatic transcription requires both an LLM stream service and an attachment service with `saveImage`.
- The route is resolved on every call using plugin overrides, panel fixed routing, active sessions, then environment variables.
- `mediaRoot` must exist and resolve through `realpath`; the root itself is not treated as an image path.
- Vision uses one API call per image. The 120-character instruction is a soft limit, not a hard output truncation.
- Stored inventory paths are durable copies, but the source path must remain under `mediaRoot` at keep time.
- Video extraction depends on a working `ffmpeg` and writes a temporary JPEG under the system temporary directory.
- The bundled patch contains `maxSide`, but current code does not read or apply it and performs no resizing.
