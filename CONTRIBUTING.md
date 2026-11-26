# Contributing to Pisces

感谢参与。Pisces 目前是 pre-1.0 参考实现，优先接受范围清楚、能验证、不会把部署私密数据带进仓库的改动。

## 开发环境

需要 Node.js 22 或更高版本（CI 使用 Node.js 24）和 pnpm。

```bash
./install.sh --check
./install.sh
node examples/walkthrough.mjs
```

依赖和包间链接由 pnpm workspace 生成。不要提交或用脚本创建手工 `node_modules` 软链。

## 改一处，查一圈

“改一处”不是只改当前文件。提交前至少检查下面这条引用链，能命中的都要同步：

1. 用 `rg -n '<旧名字或旧行为>'` 搜代码、测试、`cordis.patch.yml`、README、docs 和示例。
2. 检查包名、插件 `id`、客户端模块 `id`、`dsh.pisces` 元数据、HTTP 路由和 `cordis.patch.yml` 是否仍一致。
3. 检查跨包 import 是否仍走包名；不要改成 `../../` 或部署机器上的绝对路径。
4. 修改行为时补或更新最近的测试；不能补测试时，在 PR 里写清缺口和手工验证步骤。
5. 更新受影响的文档。文档必须描述现在的代码，不描述计划中的接口。

新增或删除插件包时，还要同步根 README 的 16 包清单、README/测试覆盖数量，以及架构文档的插件表。

## 测试要求

Pull request 在合并前必须通过现有测试，并优先补上覆盖改动的测试。

```bash
./install.sh
node examples/walkthrough.mjs
git diff --check
node -e "for (const f of require('fs').readdirSync('plugins')) { try { JSON.parse(require('fs').readFileSync('plugins/'+f+'/package.json')) } catch(e){ console.log('坏 JSON:', f) } }"
```

`install.sh` 自动发现 `plugins/*/test-*.mjs` 和 `ops/test-*.mjs`。新增测试文件必须：

- 文件名匹配 `test-*.mjs`；
- 失败时以非零退出码结束；
- 在输出中打印一行 `N 通过 / M 失败` 汇总，`install.sh` 用它统计断言数。

不要只加一个永远不会失败的展示脚本。涉及 IO 的测试应使用 `mkdtemp()` 或显式临时目录，结束后不要依赖仓库内残留状态。

## 提交内容

- 一个 PR 解决一个清楚的问题，避免夹带无关重构。
- 不提交 `.koi/`、`.credentials.yaml`、会话目录、真实平台 id、真实昵称、聊天记录或日志。
- 不提交 `node_modules/` 或生成的 pnpm store 内容。
- 修改安全边界、身份、出口判定或记忆账本时，在 PR 描述中写明兼容性和回滚方式。
- 提交的代码按仓库的 MIT License 授权。

## Pull request

PR 描述应包含：改了什么、为什么、哪些包和文档受影响、如何验证、已知缺口。
评审时可以要求拆分过大的改动，或要求为“文档声称行为”补上可执行证据。

## Before you push

Enable the local privacy gate once per clone:

```bash
git config core.hooksPath .githooks
```

It runs `tools/privacy-scan.mjs` before every push. CI runs the same scan, plus the full test suite.
