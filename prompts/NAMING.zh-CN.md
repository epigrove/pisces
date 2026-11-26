# 命名自由

中文 | [English](./NAMING.md)

- 插件包名沿用参考实现姐妹名：`dsh-koi-*`（参考 agent）/ `dsh-ashu-*`（运维 agent）。
- **你的 agent 名字、自称、人设完全自主**：通过 env `KOI_AGENT_NAME`、`KOI_SELF_TITLE`
  或 profile config 覆盖；提示词用 `prompts/system.template.md` 的 {{agentName}}/{{selfTitle}}/{{persona}}。
- 仓库不含任何真人记忆/隐私；提示词与记忆和仓库隔离，部署只更新插件代码。
