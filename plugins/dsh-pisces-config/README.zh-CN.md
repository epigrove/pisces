# dsh-pisces-config

中文 | [English](./README.md)

Pisces 的共享读取契约：统一解析数据目录、AI 配置、会话选择与通道无关身份。

## 功能

- 从显式目录、`KOI_HOME` 或用户主目录解析唯一的 koi 数据目录。
- 按 `chat`、`vision`、`gate`、`iterate` 四种用途读取 provider 与模型覆盖配置。
- 从固定配置、会话实时模型选择事件或显式回退值确定模型。
- 结合钉住 id、真人活动与子代理过滤选择投递会话。
- 把 `source.person` 规范成带平台前缀的身份 key，并判断配置中的主人。
- 为尚未迁移的 QQ 文本消息提供唯一的 legacy 提取器。

## 设计思路

AI 配置和投递目标都是“配置决定的事”，而两者的读取器必须先对配置位置达成一致。身份解析又依赖同一条数据目录规则；否则不同插件会各自推导路径，甚至读不同的 `.koi` 目录。因此把身份解析与数据目录解析收在一个包里，让所有消费者共享一个路径契约、一种身份形状和一套主人 key 格式。拆开只会让“配置”横跨更多包，耦合并没有消失。

身份最终只认 `source.person = { platform, id, name?, scope? }`。唯一 key 是 `platform:id`，平台名与 id 都转小写；`name` 只用于显示，平台 id 被当作不透明字符串。QQ 正文提取只保留为带标记的 legacy 兼容路径。

模型选择中，面板固定值只有 provider 与 model 都存在时才获胜；否则跟随存活主会话最近一次 `model/selection` 事件，最后使用调用方回退值。曾经写死 provider，结果配置过时后无法创建会话，因此放弃该方案。

投递顺序是钉住会话、人最后发言的主会话、最近活跃候选。导出的 `isHumanSource()` 采用 fail-closed 规则，只认 `source.kind === "user"`，因此运行时上下文、定时任务、压缩记录和 relay 注入不会进入依赖身份的处理。当前 `lastHumanAt()` 选择器对已声明 kind 使用白名单，但为了兼容历史消息，也会接受没有 source kind 的记录。配置必须在每次投递时重读，不能在启动时缓存；否则面板保存后看起来像消息丢了。

代价是配置读取依赖文件系统、没有 schema 迁移层，严格的发送者判定也会拒绝结构异常的数据。会话选择器要求调用方提供实时 agent 事件接口。

## 配置

| 键 | 默认值 | 作用 |
|---|---|---|
| `dir` | 未设置 | 精确指定 koi 数据目录，优先级最高的路径覆盖。 |
| `koiHome` | `$KOI_HOME` | 在其后追加 `.koi` 的基础目录。 |
| `home` | `$HOME` 或操作系统主目录 | 最终追加 `.koi` 的基础目录。 |
| `ai.chat.provider`、`ai.chat.model` | 空；再回退 `MODEL_PROVIDER`、`MODEL_NAME` | 主聊天 AI 选择，也是其它用途的回退。 |
| `ai.vision.provider`、`ai.vision.model` | 回退 `ai.chat`，再回退环境变量 | 识图 AI 选择。 |
| `ai.gate.provider`、`ai.gate.model` | 回退 `ai.chat`，再回退环境变量 | 门控/判断 AI 选择。 |
| `ai.iterate.provider`、`ai.iterate.model` | 回退 `ai.chat`，再回退环境变量 | 迭代/提案 AI 选择。 |
| `api.mode` | `follow` | `fixed` 时 `koiModel` 使用 `api.provider` 与 `api.model`；其它值跟随实时会话。 |
| `api.provider`、`api.model` | 空 | 固定模型对，只在 `api.mode` 为 `fixed` 时使用。 |
| `sessionId` | 空 | 传给 `pickAgent` 的可选会话 pin。 |

## 接口

- 导出 `ai-config.mjs` 与 `identity.mjs` 的库接口；没有 bundle 插件 id、HTTP 路由、工具或事件。
- 模型/会话导出：`resolveKoiDataDir`、`aiConfig`、`lastModelOf`、`pickModel`、`koiModel`、`isSubAgent`、`idOf`、`isHumanSource`、`humanKindOf`、`lastHumanAt`、`pickAgent`。
- 身份导出：`personOf`、`personKeyOf`、`personNameOf`、`isOwnerPerson`、`legacyKeyFromText`。
- 不注入服务。`aiConfig()` 读取 `<dataDir>/ashu-config.json`；选择函数消费调用方传入的 agent 与 override 对象。

## 验证

```bash
cd <repo>
node plugins/dsh-pisces-config/test-config.mjs
node plugins/dsh-pisces-config/test-identity.mjs
```

预期：先输出 `31 通过 / 0 失败`，再输出 `22 通过 / 0 失败`；两条命令退出码均为 0。

## 说明与限制

- `ashu-config.json` 损坏或不可读时，`aiConfig()` 会记录日志并回退到空值或已配置来源，不做 schema 校验或迁移。
- 没有会话事件与回退值时，`pickModel` 可能返回空 provider/model。
- `lastHumanAt` 为兼容历史消息，会接受没有 source kind 的 `user/message`；严格 fail-closed 的 `kind === "user"` 判定只在 `isHumanSource` 中。
- Legacy 提取器只识别 `[Current message]` 之后、历史格式中带括号的 32 位十六进制 QQ id。
- 本包只读配置，不提供 GUI 写入，也不执行 revision 冲突检测。
