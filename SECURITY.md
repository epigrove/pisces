# Security Policy

[中文](./SECURITY.zh-CN.md) | English

## Supported versions

Pisces is pre-1.0. Security fixes are applied to the default branch, currently
`master`; there are no long-term support branches for older versions. Include
the affected commit, package name, and conditions required to reproduce the
issue in every vulnerability report.

## Report vulnerabilities privately

**Do not open a public issue for an unfixed vulnerability, and do not paste
exploit code, credentials, or real chat data into an issue.**

Prefer the GitHub repository's private security advisory channel: **Security →
Report a vulnerability**. If that channel is unavailable, contact the
maintainers through a private contact method listed on their GitHub profiles.
In your first message, say only that you need to report a security issue
privately; do not include sensitive details yet.

A report should include:

- the affected package, version, or commit;
- the vulnerability type and impact;
- minimal reproduction steps or a proof of concept;
- the configuration and permissions required to trigger the issue;
- redacted logs;
- a suggested direction for the fix (optional).

## Scope

Reports are welcome for issues including, but not limited to:

- bypasses of the `dsh-koi-guard` path allowlist;
- bypasses of outbound gating, message signing, or delivery deduplication;
- secret disclosure through prompt injection, tool calls, or memory injection;
- missing authentication on panel routes, credential reflection, or
  unauthorized writes;
- disclosure of real identifiers by privacy scans, published copies, or CI;
- arbitrary code execution risks in dependencies, patches, or the plugin
  loading chain.

Use your own test deployment and redacted data. Do not access, modify, or
disclose another person's agent data, accounts, credentials, or session
records.

## Handling

Maintainers will first confirm the report, assess its impact, and prepare a
fix. Coordinate the public disclosure date with the maintainers and leave time
for upgrading and deploying the fix. Do not publish directly exploitable
details before the fix is released. No response-time SLA is promised.
