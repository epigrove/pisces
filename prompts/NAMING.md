# Naming freedom

[中文](./NAMING.zh-CN.md) | English

- Plugin package names retain the sibling names from the reference
  implementation: `dsh-koi-*` (reference agent) and `dsh-ashu-*` (operations
  agent).
- **Your agent's name, self-description, and persona are entirely yours to
  define.** Override them with the `KOI_AGENT_NAME` and `KOI_SELF_TITLE`
  environment variables or through profile config. Prompts use
  `{{agentName}}`, `{{selfTitle}}`, and `{{persona}}` from
  `prompts/system.template.md`.
- The repository contains no real person's memory or private data. Prompts and
  memory are isolated from the repository, and deployment only updates plugin
  code.
