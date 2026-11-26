# dsh-pisces-panel

中文 | [English](./README.md)

宿主侧的 Web GUI：编辑对端 agent 的模型、投递、命名、凭据与插件开关配置。

## 功能

- 在宿主左栏注册 **Pisces 配置** 入口。
- 提供当前 API/模型状态、可选 provider/model、存活主会话与对端插件目录。
- 把 `api`、`proposal`、`defaults`、`naming`、`ai` 分区合并写入 `<KOI_HOME>/.koi/ashu-config.json`。
- 写入 provider 凭据，但不向浏览器回显。
- 扫描包元数据与 bundle patch 列出可切换插件和依赖，再用 SHA-256 revision 检测并发修改并写入对端 patch 的 `disabled`。
- 以只读方式显示身份文件路径。

## 设计思路

模型与投递语义的唯一读口是 **`dsh-pisces-config`**。面板是同一份 `ashu-config.json` 格式的 GUI 写入端，不另造一套磁盘配置模型。固定模型只写对端 override，绝不写共享模型环境文件，因为修改共享值会连宿主 agent 一起改掉。

修改共享 profile 文本的写入需要 revision 冲突检测。`GET /pisces/plugins` 返回当前 patch 的 SHA-256 revision；`POST /pisces/plugins/toggle` 携带该 revision，如果文件已被改动，就返回 HTTP 409 和当前 revision。这样两个陈旧浏览器标签页不会静默覆盖彼此的插件状态。当前 `POST /pisces/override` 只做分区合并，没有 revision token，因此 `ashu-config.json` 还没有同样的 compare-and-swap 保证。

插件条目从磁盘发现，而不是写死在界面里：分类来自包的 `dsh.pisces` 元数据，id 来自包的 bundle patch，依赖从包元数据收窄到对端 bundle 闭包。这样新增插件无需改面板，也不会把复制到同一目录的宿主专属包误显示成对端开关。

凭据写入只作用于对端：宿主与对端共用一个 DSH home 时优先使用宿主 credentials 服务，否则原子更新对端的 `.credentials.yaml`。凭据 YAML 损坏时先备份并拒绝写入。代价是切换插件后必须重启对端，配置不是热加载。

## 配置

| 键 | 默认值 | 作用 |
|---|---|---|
| `koiHome` | `$KOI_HOME`，否则 `$HOME/koi` | 对端根目录，包含 `.koi`、`.dsh-home` 与 `plugins`。 |
| `sharedModelEnv` | `$PISCES_SHARED_MODEL_ENV`，否则为空 | 可选共享模型环境文件，用作实时模型回退。 |

面板还用 `DSH_HOME` 判断 credentials 服务能否写入对端凭据。命名回退读取 `KOI_AGENT_NAME`、`KOI_SELF_TITLE`、`QQBOT_ALIASES`、`KOI_MASTER_NAME`、`KOI_OWNER_OID8`、`KOI_OWNER_QQ`；override 中已保存的命名值优先。

## 接口

- 包 id：`dsh-pisces-panel`。
- Bundle 条目 id：`pisces-config-config`；运行时插件名：`pisces-config`。
- HTTP 路由：

| 方法 | 路由 | 用途 |
|---|---|---|
| `GET` | `/pisces/state` | 返回生效的 API/override 状态、实时模型、身份路径、命名与默认值。 |
| `GET` | `/pisces/models` | 返回从对端 `llm-providers.yml` 解析的 provider/model，以及是否配置 key，不回显 key。 |
| `POST` | `/pisces/key` | 把 `{ env, value }` 写入对端凭据存储。 |
| `GET` | `/pisces/sessions` | 列出非子代理宿主会话及最后真人活动时间。 |
| `GET` | `/pisces/plugins` | 按对端闭包列出插件元数据、依赖、revision 与开关状态。 |
| `POST` | `/pisces/plugins/toggle` | 把 `{ id, enabled, revision }` 写入对端 patch，并返回 `needRestart: true`。 |
| `POST` | `/pisces/override` | 把允许写入的配置分区合并进 `ashu-config.json`。 |

- 不注册工具或宿主事件。
- 依赖服务：`webServer`；可选用 `agents` 查询会话/模型，宿主与对端共用一个 DSH home 时可选用 `credentials`。

## 验证

```bash
cd <repo>
node plugins/dsh-pisces-panel/test-regressions.mjs
node plugins/dsh-pisces-panel/test-contract-audit.mjs
```

预期：先输出 `2 通过 / 0 失败`，再输出 `5 通过 / 0 失败`；两条命令退出码均为 0。

## 说明与限制

- `/pisces/override` 当前没有 revision/CAS token；并发写入可能在读取与原子 rename 之间竞争。
- 插件开关写入使用 revision 冲突检测，不匹配时返回 HTTP 409。
- 插件改动后必须重启对端，面板不会热加载运行中的对端。
- 身份文件只显示服务端路径，不能在此编辑。
- 后端目前保留了一份模型/会话选择辅助实现；共享语义契约仍是 `dsh-pisces-config`。
- 面板只列 profile 依赖/bundle 闭包中的对端包；没有 bundle 插件 id 的包显示为不可切换的库。
- 本地 `lastHumanAt` 辅助函数为兼容历史消息，会接受没有 source kind 的 `user/message`。
