## Summary

What problem does this PR solve, and what is the resulting behaviour?

## Scope

- Packages or documents touched:
- Does it change configuration, data format, routes, or plugin ids:
- Does it need a migration or a restart:

## Check the blast radius

- [ ] I searched every reference to old package names, routes, terminology, and behaviour.
- [ ] Package name, plugin id, client module id, `dsh.pisces` metadata, and `cordis.patch.yml` stay consistent.
- [ ] Cross-package imports use package names; no new machine-absolute paths or manual symlinks.
- [ ] README/docs/examples match the code; adding or removing a plugin updated the full list.

## Verification

- [ ] `./install.sh`
- [ ] `node examples/walkthrough.mjs`
- [ ] `git diff --check`
- [ ] Every changed `package.json` parses as JSON
- [ ] New or changed behaviour is covered by a test, or the text below explains why not

Verification output or manual steps:

```text

```

## Risk and rollback

Describe compatibility, data risk, security impact, and how to roll back.

## Privacy check

- [ ] No real user data, logs, openids, nicknames, chat logs, or credentials.
- [ ] Examples and tests use placeholder data only.
