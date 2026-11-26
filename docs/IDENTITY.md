[中文](./IDENTITY.zh-CN.md) | English

# Identity abstraction: plugins do not know QQ

### Why

The agent is not a QQ agent; QQ is only one channel in current use. Plugins must
continue to work after every QQ-related line is removed, especially where people are
identified.

### Shape

Structured identity is attached to `source.person` on a message:

```js
source = {
  kind: 'user',
  person: {
    platform: 'qq',   // platform name, used only to build the key
    id: 'A48CF4DD…',  // stable id within the platform
    name: 'some nickname', // display name for this occurrence; for human display only
    scope: 'group',   // c2c / group (optional)
  },
}
```

Three rules:

1. **`id` is the unique identifier**. `name` can change or collide, so it cannot be
   used as a key.
2. **Keys include the platform prefix**: `<platform>:<id>`. Bare ids may collide across
   platforms.
3. **The channel owns translation**. Mapping platform fields to `person` happens in
   the channel layer; plugins do not parse `[nickname (openid)]` unless they explicitly
   use the migration fallback marked as legacy.

### Interface

`dsh-pisces-config/identity.mjs`:

| Function | Current status |
|---|---|
| `personOf(source)` | Gets structured identity; returns `null` when absent. Has unit tests and is consumed by memory |
| `personKeyOf(source)` | Produces a lowercase `<platform>:<id>`; has unit tests |
| `personNameOf(source)` | Display name; falls back to the first 8 characters of the id when the name is absent. Consumed by audit |
| `isOwnerPerson(source, owners)` | **Reserved interface, not wired up yet**; currently there are only docs and tests, and no plugin reads `owners` or calls it for authorization |
| `legacyKeyFromText(text)` | Transitional fallback: gets identity from `[nickname (32-hex)]`; new channels should not depend on it |

`owners: ['qq:<id>', 'web:<id>']` is only a reserved configuration shape; it does not
mean the repository already implements owner-based allow/block behavior. When owner
permissions are required, the caller must read the configuration itself and wire the
check in explicitly.

### External prerequisite: qqbot inbound patch

Attaching `source.person` to qqbot inbound events requires patching
`@tencent-connect/dsh-qqbot`. **This repository does not include that qqbot patch.**
`ops/patch-qqbot.mjs` only checks whether four changes are present; it does not apply
the patch.

Operators must maintain a patch that can be replayed with `pnpm install` and verify the
following content:

```js
source = {
  kind: 'user',
  person: {
    platform: 'qq',
    id: senderId, // stable openid
    name: displayName,
    scope: messageKind,
  },
}
```

To verify against the actual package:

```bash
QQBOT_PKG=/path/to/dsh-qqbot node ops/patch-qqbot.mjs
```

### Behavior without the patch

- `dsh-koi-memory` still listens for messages. When the `[nickname (32-hex)]` text
  marker is present, it falls back to the old parser and takes the name and the first
  8 characters of the id.
- When there is neither `source.person` nor that marker, short-term memory can still
  be written, but the speaker falls back to `group member` and has no stable person
  identifier.
- When assigning quoted attribution, `dsh-koi-audit` first uses
  `personNameOf(source)`, then falls back to the legacy name in the message body.
  When neither is available, audit can still write, but "who said it" cannot be
  determined.
- `personKeyOf()` / `isOwnerPerson()` can only produce an empty key or `false` for
  missing structured identity; by themselves they do not stop message processing.

These fallbacks do not crash the plugins, but they lose the key cross-platform
identity capability. An open-source deployment that uses QQ should therefore list
this patch as an external prerequisite.

### Migration status

| Area | Status |
|---|---|
| Identity interface and unit tests | ✅ |
| qqbot inbound `source.person` | **External prerequisite**: apply the patch yourself; the repository only has a checking script |
| Memory who/oid | ✅ Prefers `source.person` when present; otherwise falls back to message parsing or `group member` |
| Audit speaker attribution | ✅ Prefers structured identity; falls back when legacy identity is used or missing |
| Chat | ✅ Does not parse platform identity |
| Gate `@` / group-card handling | ✅ Channel adaptation that retains platform-specific checks |
| Lexicon key shape | ⏳ Still uses the old key convention; migration affects existing data |
| `isOwnerPerson()` / `owners` | ⏳ Reserved, not wired up yet |
