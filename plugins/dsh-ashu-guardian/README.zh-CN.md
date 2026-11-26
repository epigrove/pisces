# dsh-ashu-guardian

中文 | [English](./README.md)

宿主侧的进程看护插件：按配置拉起对端 agent、定时巡检，并可在重新拉起前同步 API 配置。

## 功能

- 检查是否存在匹配 Node 与 `dsh --profile koi` 的存活对端进程。
- 当 `adopt` 开启且对端不存在时，调用部署提供的 `script --daemon` 启动器。
- 在允许重新拉起之前，运行可选的 API 同步脚本。
- 让定时巡检独立于 API 同步：同步缺失或失败不会关闭看护。
- 限制巡检间隔、应用 15 秒拉起冷却，并在 `pgrep` 自身失败时避免重复拉起。
- 插件卸载时默认保留对端；`killOnDispose` 只终止直接启动器子进程。

## 设计思路

部署事实是：进程如果留在 `dsh-web` 的 cgroup 里，会随 `dsh-web` 一起被杀掉。因此，把对端当普通子进程拥有并不能解决生命周期问题。插件执行 `spawn('/bin/bash', [script, '--daemon'], { instrument: false })`，要求启动器用 `nohup setsid` 让真正的对端脱离；短命的启动器随后退出，而 `instrument: false` 防止这次退出被当作宿主单元退出。

每轮巡检都无条件检查对端是否存在，与 API 同步结果无关。同步可以执行并记录结果，但结果只约束“是否拉起”。当配置了同步且同步失败时，`allowStale: false` 会让本轮不拉起，而不是带着错误的 provider、模型或凭据静默启动。必须拆开这两件事，因为开源模板默认把 `syncScript` 留空；把“未配置”误判成“失败”曾导致巡检本身完全停止。

看护逻辑使用 `pgrep -af`，再自行校验完整命令行。`pgrep` 的非 1 错误被当作“状态未知”，不能当作“没有进程”，否则误判为空会拉起第二个对端，两个进程争抢同一个通道。

没有采用 systemd 直接托管：实测对端的 `spill-local` 会在 systemd mount namespace 下遇到只读 `/tmp`。也没有直接 detached spawn 一个前台 `dsh`，因为它仍共享宿主沙箱，可能触发单元回收并破坏宿主自己的 namespace。代价是形成一项外部启动器约定：配置的脚本必须自行校验环境、完成 daemon 化，并正常退出。

## 配置

| 键 | 默认值 | 作用 |
|---|---|---|
| `enabled` | `true` | 设为 `false` 时完全关闭看护。 |
| `script` | 未写时取 `${KOI_HOME}/ops/start.sh`；bundle 中写为 `''` | 以 `script --daemon` 调用的启动器；空值会关闭接管。 |
| `cwd` | `$KOI_WORKDIR`，否则 `$HOME/workspace` | 启动器工作目录。 |
| `intervalMs` | `60000` | 毫秒级巡检间隔，限制在 15,000–3,600,000。 |
| `adopt` | `true` | 对端不存在时拉起；`script` 为空时强制关闭。 |
| `syncScript` | `''` | 每轮巡检尝试运行的 Node 同步脚本，其结果只约束是否拉起；空值表示未配置同步。 |
| `killOnDispose` | `false` | 插件卸载时向直接启动器子进程发送 `SIGTERM`。 |
| `allowStale` | `false` | 配置了同步但同步失败时，是否仍允许拉起。 |

`KOI_HOME` 与 `KOI_WORKDIR` 提供上述默认值。当前进程匹配模式中的 profile 名固定为 `koi`。

## 接口

- 包 id：`dsh-ashu-guardian`；bundle 条目与运行时插件 id：`ashu-guardian`。
- 不注册 HTTP 路由、工具或事件。
- 注入服务：无。
- 外部依赖：`pgrep`、`/bin/bash`、配置的启动器以及可选的同步脚本。

## 验证

```bash
cd <repo>
node --check plugins/dsh-ashu-guardian/lib/index.js
node -e "import('./plugins/dsh-ashu-guardian/lib/index.js').then(m => console.log(m.name, typeof m.apply))"
```

预期：两条命令退出码均为 0，第二条输出 `ashu-guardian function`。

## 说明与限制

- 本包没有自动化测试套件。
- 看护依赖宿主进程表；`pgrep` 不存在或报错时会跳过该轮。
- 进程匹配模式固定，针对 `koi` profile。
- `killOnDispose` 只作用于启动器子进程；正确 daemon 化的对端应比启动器活得更久。
- 日志刻意使用带 `[ashu-guardian]` 前缀的 `console.log`，确保部署日志中始终可见。
