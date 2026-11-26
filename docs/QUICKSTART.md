# 快速开始 / Quick start

> 目标：把这个 DSH 插件集装好、跑通示例，并准备一份最小可运行的数据目录。
> Goal: install the DSH plugin set, run the example, and prepare a minimal data directory.

这个仓库是插件集，不是附带完整 `cordis.patch.yml` 的可独立启动应用。真正运行时，
需要把这些包挂进你的 DSH profile，并接入一个通道插件。

---

## 中文

### 0. 前提

| 依赖 | 说明 |
|---|---|
| Node.js ≥ 22 | CI 使用 Node.js 24 |
| pnpm | 负责 workspace 链接；不要手改 `node_modules` |
| DSH | 插件宿主，可选但实际运行 agent 时必需 |

### 1. 安装前检查

```bash
./install.sh --check
```

这里只检查 Node、pnpm 和 DSH 是否可发现，不安装依赖、不写运行数据。
缺 Node 或 Node 版本过低会直接失败；缺 pnpm/DSH 目前只给警告并以 0 退出，
所以要看输出，不能只看退出码。

### 2. 安装并跑全部测试

```bash
./install.sh
```

它会执行 `pnpm install`、语法检查、未定义引用检查和当前已有的
`test-*.mjs`。测试覆盖并非每包都有，实际缺口见
[README 的插件清单](../README.md#插件清单)。

再看一个不写文件的最小示例：

```bash
node examples/walkthrough.mjs
```

### 3. 选择数据目录

不同插件支持的数据目录覆盖键不完全一样：

- 有 `dir` 配置的插件优先用它；
- 支持 `KOI_HOME` 的插件把 `$KOI_HOME/.koi` 当数据目录；
- 支持这些覆盖项的数据插件在两者都没设置时，默认数据目录是 `$HOME/.koi`。

`KOI_HOME` 表示包含 `.koi/` 的 agent 根目录，不是 `.koi` 目录本身。
不要假设所有插件都读它；插件只支持 `dir` 时，要在该插件配置里显式设置
`dir`。宿主管护/投递类插件还有自己的根目录默认值，以各自 README 为准。

```bash
# 使用默认 $HOME/.koi 时可不设置
export KOI_HOME="$HOME/myagent"
export DATA_DIR="${KOI_HOME:-$HOME}/.koi"
mkdir -p "$DATA_DIR"
```

常用命名变量：

| 变量 | 用途 |
|---|---|
| `KOI_AGENT_NAME` | agent 名称的部署级默认值 |
| `KOI_SELF_TITLE` | 自称；面板和提示词模板使用 |
| `KOI_MASTER_NAME` | 对用户的称呼 |
| `KOI_OWNER_QQ` / `KOI_OWNER_OID8` | 兼容旧身份路径的占位标识；新通道优先提供 `source.person` |

### 4. 手工放入身份锚点

`profile.core.md` **不会被自动创建**。记忆插件只读取它；核心设定默认不允许
agent 自己改写，所以首次运行前由运维方手工放好：

```bash
cat > "$DATA_DIR/profile.core.md" <<'EOF'
# 核心设定

- 名称：给 agent 的名字
- 自称：第一人称称呼
- 对用户的称呼：你希望它怎么称呼你
- 不可更改的边界：例如不冒充他人、不泄露凭据
EOF
```

如果你的插件配置把 `dir` 或 `coreFile` 指向别处，请把文件放到那里。

其余运行文件由插件在第一次实际写入时创建，例如：

```text
$DATA_DIR/
├── long.jsonl
├── medium.jsonl
├── medium.index.json
├── short/YYYY-MM-DD.jsonl
├── lexicon.json
└── profile.core.md       # 手工创建，不是运行时自动生成
```

账本只追加、不重写。`medium.index.json` 中的 `stale` 标记表示中期记忆暂时
不注入；长期记忆的 `obsolete` 标记表示废弃但仍可通过 recall 查到。两者都不是删除。

### 5. 接入 DSH 与通道

在你的 DSH profile 中：

1. 用 workspace 依赖挂载需要的 `dsh-*` 包；
2. 把包的 `cordis.patch.yml` 或对应 bundle 加进 profile；
3. 接入一个通道插件，并在收包和发包处分别调用 `dsh-koi-gate`。

不要手工软链插件。Profile 与仓库应在同一个 pnpm workspace，或由 pnpm
以本地包方式安装；最后在 workspace 根执行 `pnpm install`。

通道接入细节见 [CHANNEL.md](./CHANNEL.md)。

### 6. 两种“体检”分开用

**安装前环境检查**：

```bash
./install.sh --check
```

它只回答“这台机器是否具备安装条件”。

**运行期数据体检**：

```bash
KOI_HOME=/path/to/agent node tools/health.mjs
```

它读取运行数据、会话、日志和插件状态，回答“已经跑起来的系统哪里不对”。
未安装依赖或还没有运行数据时，运行期体检不能替代安装检查。

### FAQ

**改了配置为什么没生效？**

负责模型和投递的读取点会在使用时重读配置；插件开关这类写入
`cordis.patch.yml` 的变更仍需重启 agent。

**能不能手改账本？**

技术上可以，但不要把它当正常流程。写入应走插件，以免绕过侧车索引；
账本完整性指纹可以事后发现旁路修改。

**能不能删记忆？**

设计上不删：中期用侧车里的 `stale` 标记停止主动注入，长期用 `obsolete`
标记停止注入但保留 recall。物理删除是数据持有者自己的处置，但会破坏
“账本即历史”的性质。

**用什么模型？**

仓库不绑定 provider。`dsh-pisces-config` 支持从
`ashu-config.json` 的 `ai.*`、`MODEL_PROVIDER` / `MODEL_NAME` 以及会话中的
实际模型选择读取；面板支持 `follow`、`fixed`、`manual` 三种模式。

---

## English quick start

This repository is a DSH plugin collection. Mount the packages in a DSH profile and
add a channel plugin for an actual agent deployment.

### 1. Check, install, test

```bash
./install.sh --check   # environment only; inspect warnings as well as the exit code
./install.sh           # pnpm install + static checks + existing tests
node examples/walkthrough.mjs
```

Test coverage is intentionally reported per package in the
[plugin inventory](../README.md#插件清单); not every package has a test.

### 2. Choose the data directory

Precedence depends on the plugin:

- a plugin's explicit `dir` wins;
- plugins that read `KOI_HOME` use `$KOI_HOME/.koi`;
- with neither setting, data plugins that support these overrides default to `$HOME/.koi`.

`KOI_HOME` is the agent root containing `.koi/`, not the `.koi` directory itself.
Host-side relay/guardian plugins have their own root defaults; check their READMEs.

```bash
export KOI_HOME="$HOME/myagent"
export DATA_DIR="${KOI_HOME:-$HOME}/.koi"
mkdir -p "$DATA_DIR"
```

### 3. Create the core identity file manually

`profile.core.md` is read by the memory plugin and is not auto-created:

```bash
cat > "$DATA_DIR/profile.core.md" <<'EOF'
# Core identity

- Name: your agent name
- Self-reference: how it refers to itself
- User title: how it addresses you
- Non-negotiable boundaries: no impersonation, no credential disclosure
EOF
```

Other files in `$DATA_DIR` are created when the relevant plugin first writes data.

### 4. Mount the plugins

Add the packages you need to a DSH profile through pnpm workspace dependencies,
register their `cordis.patch.yml` bundles, and connect an inbound/outbound channel.
Use `createGate()` for inbound wake-up decisions and `allow()` before sending.
See [CHANNEL.md](./CHANNEL.md).

### 5. Check the running system

```bash
KOI_HOME=/path/to/agent node tools/health.mjs
```

This runtime health check reads agent data and logs. It is separate from
`./install.sh --check`, which only validates the installation environment.
