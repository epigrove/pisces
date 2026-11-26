中文 | [English](./IDENTITY.md)

# 身份抽象：插件不认识 QQ

### 为什么

agent 不是 QQ agent；QQ 只是当前使用的一种通道。插件必须能在删掉所有 QQ
相关代码后继续工作，尤其是人的唯一标识符。

### 形状

结构化身份挂在消息的 `source.person` 上：

```js
source = {
  kind: 'user',
  person: {
    platform: 'qq',   // 平台名，只用来拼 key
    id: 'A48CF4DD…',  // 平台内稳定 id
    name: '某个昵称', // 这次显示的名字，只给人看
    scope: 'group',   // c2c / group（可选）
  },
}
```

三条规矩：

1. **`id` 才是唯一标识**。`name` 会变、会重名，不能当 key。
2. **key 带平台前缀**：`<platform>:<id>`，不同平台的裸 id 可能撞。
3. **通道负责翻译**。平台字段到 `person` 的映射在通道层；插件不解析
   `[昵称 (openid)]`，除非显式使用标注为 legacy 的迁移兜底。

### 接口

`dsh-pisces-config/identity.mjs`：

| 函数 | 现状 |
|---|---|
| `personOf(source)` | 取结构化身份；没有返回 `null`，已有单测和 memory 消费 |
| `personKeyOf(source)` | 生成小写的 `<platform>:<id>`，已有单测 |
| `personNameOf(source)` | 显示名；缺名时退回 id 前 8 位，audit 有消费 |
| `isOwnerPerson(source, owners)` | **预留接口，尚未接线**；当前只有文档和测试，没有插件读取 `owners` 或调用它做权限判断 |
| `legacyKeyFromText(text)` | 过渡兜底：从 `[昵称 (32位 hex)]` 取身份，新通道不应依赖 |

`owners: ['qq:<id>', 'web:<id>']` 只是预留的配置形状，不代表仓库已经实现
“按 owner 放行/拦截”。需要主人权限时，调用方必须自己读取配置并显式接入。

### 外部前置条件：qqbot 入站补丁

让 qqbot 入站事件带上 `source.person` 需要给
`@tencent-connect/dsh-qqbot` 打补丁。**本仓库没有附带这份 qqbot patch。**
`ops/patch-qqbot.mjs` 只检查四处改动是否在位，不会打补丁。

部署方应自行维护可随 `pnpm install` 重放的 patch，并检查以下内容：

```js
source = {
  kind: 'user',
  person: {
    platform: 'qq',
    id: senderId, // 稳定 openid
    name: displayName,
    scope: messageKind,
  },
}
```

验证方式可指向实际包：

```bash
QQBOT_PKG=/path/to/@tencent-connect/dsh-qqbot node ops/patch-qqbot.mjs
```

### 没有补丁时的降级行为

- `dsh-koi-memory` 仍会监听消息；有 `[昵称 (32位 hex)]` 文本标记时，退回旧解析，
  从中取名字和 id 前 8 位。
- 既没有 `source.person`、正文也没有上述标记时，短期记忆仍能写，但说话人降级为
  `群友`，且没有稳定的人标识。
- `dsh-koi-audit` 做引号归属时会先用 `personNameOf(source)`，再退回正文里的
  legacy 名字；两者都没有时，审计仍可写，但“谁说的”不可判定。
- `personKeyOf()` / `isOwnerPerson()` 对缺失的结构化身份只能得到空 key 或 `false`；
  它们本身不会阻止消息处理。

降级不会让插件崩溃，但会失去跨平台身份的关键能力，所以开源部署若使用 QQ，
应把这份补丁列为外部前置条件。

### 迁移状态

| 位置 | 状态 |
|---|---|
| 身份接口与单测 | ✅ |
| qqbot 入站 `source.person` | **外部前置条件**：需自行打补丁；仓库只有检查脚本 |
| memory 的 who/oid | ✅ 有 `source.person` 时优先，否则退回正文解析或 `群友` |
| audit 的说话人归属 | ✅ 有结构化身份时优先，legacy/缺失时降级 |
| chat | ✅ 不解析平台身份 |
| gate 的 `@`/群名片 | ✅ 属于通道适配，保留平台判断 |
| lexicon 的 key 形态 | ⏳ 仍使用旧 key 约定，迁移会牵动存量数据 |
| `isOwnerPerson()` / `owners` | ⏳ 预留，尚未接线 |
