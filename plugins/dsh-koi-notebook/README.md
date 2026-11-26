# dsh-koi-notebook

[中文](./README.zh-CN.md) | English

Stores long-form skills, events, and mechanism notes outside the always-injected memory context.

## What it does

- Appends each note body as a separate Markdown file and its metadata to a JSONL index.
- Uses only three broad caller-selected kinds: `skill`, `event`, and `state`.
- Returns a self-contained pointer containing the title, trigger condition, literal keywords, and note id.
- Lists or searches notes by title, tags, and summary, excluding archived notes by default.
- Reads a whole note or one section; when a body exceeds 4,000 characters, it returns a section directory first.
- Archives or restores a note by appending an index update while keeping its body readable.

## Design rationale

- **Notebook must be separate from memory because its content cannot be injected every turn.** The agent has no general file-write tool, and putting long procedures or event records into ordinary memory consumes prompt budget and decays. Notebook content is zero-injected until explicitly opened.
- **Pointers must survive memory truncation.** Memory text may be clipped around 100 characters, which could remove the id at the end. `pointerOf()` always preserves the complete id and compresses title, trigger, and keywords into a 96-character pointer so the memory-line index remains usable.
- **The index is append-oriented and retains history.** Archiving adds a new `{id, archived: true}` row instead of rewriting old metadata. Reads merge by id with later rows winning; restoring is another append, so no source record disappears.
- **Reads are bounded.** A whole note over 4,000 characters returns only its section directory and first section. A requested section is likewise capped at 4,000 characters and clearly marked when truncated.

## Configuration

| Key | Default | Effect |
|---|---|---|
| `dir` | `<KOI_HOME>/.koi/notebook` | Directory for the index and Markdown bodies. |
| `KOI_HOME` | User home directory | Base directory when `dir` is empty. |

## Interface

Plugin id: `koi-notebook`. Injected service: `tools`.

| Name | Type | Effect |
|---|---|---|
| `note_save` | tool | Writes the body and metadata row and returns a pointer. |
| `note_archive` | tool | Appends an archived or restored state for a note id. |
| `note_open` | tool | Lists, searches, or reads a note or section. |
| Events and prompt sections | none | Notebook content never enters the prompt automatically. |

## Verify

Run from the repository root:

```bash
node plugins/dsh-koi-notebook/test-note-open.mjs
```

The test prints `✅` or `❌` per assertion and ends with `N 通过 / 0 失败`; exit status `0` means every check passed.

## Notes / Limitations

- Notebook content is not injected automatically and does not decay.
- Search is literal substring matching over titles, tags, and summaries; it does not search body semantics.
- `note_save` writes the body before the index. A disk failure between the two writes can leave an orphan Markdown file.
- Bad index lines are skipped and logged but not repaired in place.
- Archiving only hides a note from the default list; it neither deletes nor edits the body.
