# Contributing to Pisces

[中文](./CONTRIBUTING.zh-CN.md) | English

Thank you for contributing. Pisces is currently a pre-1.0 reference
implementation. Contributions are most likely to be accepted when their scope
is clear, their behavior can be verified, and they do not bring private
deployment data into the repository.

## Development setup

You need Node.js 22 or newer (CI uses Node.js 24) and pnpm.

```bash
./install.sh --check
./install.sh
node examples/walkthrough.mjs
```

pnpm workspaces create dependencies and links between packages. Do not commit
hand-written `node_modules` symlinks, and do not create them with scripts.

## Change one thing, then follow every reference

"Change one thing" does not mean changing only the file where the change
originates. Before submitting, inspect at least this chain of references and
update every affected location:

1. Run `rg -n '<old name or old behavior>'` across code, tests,
   `cordis.patch.yml`, the README, docs, and examples.
2. Check that package names, plugin `id` values, client module `id` values,
   `dsh.pisces` metadata, HTTP routes, and `cordis.patch.yml` remain consistent.
3. Confirm that cross-package imports still use package names. Do not replace
   them with `../../` paths or absolute paths from a deployment machine.
4. Add or update the nearest test when changing behavior. If a test cannot be
   added, describe the gap and the manual verification steps in the pull
   request.
5. Update affected documentation. Documentation must describe the code as it
   exists now, not an interface that is only planned.

When adding or removing a plugin package, also update the 16-package list and
the README/test counts in the root README, as well as the plugin table in the
architecture documentation.

## Testing requirements

A pull request must pass the existing tests before it can be merged. Prefer
adding tests that exercise the change.

```bash
./install.sh
node examples/walkthrough.mjs
git diff --check
node -e "for (const f of require('fs').readdirSync('plugins')) { try { JSON.parse(require('fs').readFileSync('plugins/'+f+'/package.json')) } catch(e){ console.log('坏 JSON:', f) } }"
```

`install.sh` automatically discovers `plugins/*/test-*.mjs` and
`ops/test-*.mjs`. Every new test file must:

- use a filename that matches `test-*.mjs`;
- exit with a non-zero status when it fails;
- print one summary line as `N 通过 / M 失败`, exactly as consumed by
  `install.sh`. `install.sh` uses this line to count assertions.

Do not add only a display script that can never fail. Tests that perform I/O
must use `mkdtemp()` or an explicit temporary directory and must not depend on
state left in the repository after they finish.

## What to submit

- Use one pull request for one clearly defined problem, without unrelated
  refactoring.
- Do not commit `.koi/`, `.credentials.yaml`, session directories, real
  platform IDs, real display names, chat histories, or logs.
- Do not commit `node_modules/` or generated pnpm store contents.
- When changing security boundaries, identity, outbound decisions, or the
  memory ledger, state compatibility and rollback considerations in the pull
  request description.
- Submitted code is licensed under the repository's MIT License.

## Pull requests

A pull request description should state what changed, why it changed, which
packages and documents are affected, how it was verified, and what gaps remain.
Reviewers may ask for an oversized change to be split or for executable
evidence that supports a documented behavior.

## Before you push

Enable the local privacy gate once per clone:

```bash
git config core.hooksPath .githooks
```

It runs `tools/privacy-scan.mjs` before every push. CI runs the same scan, plus
the full test suite.
