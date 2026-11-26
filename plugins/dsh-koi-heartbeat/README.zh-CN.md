# dsh-koi-heartbeat

中文 | [English](./README.md)

安排 agent 自发唤醒，并把每次唤醒启动为完整的 agent 回合。

## 它做什么

- 让 agent 用“等会儿、一两个小时后、傍晚、今晚、睡到明天”五种定性档选择下次醒来时间。
- 把定性档换算成具体时间，并把普通档夹在配置的最短与最长间隔之间。
- 使用滚动 24 小时次数上限，并允许夜间额外额度。
- 通过 `agent.followup()` 注入心跳消息，使正式回合照常加载人设、记忆、情绪和工具。
- 用巡检与兜底排期保证漏掉一次定时器不会永久停掉后续唤醒。
- 暴露工具来安排下一次唤醒，以及查看当前排期和近期次数。
- 在显式开启、设置截止时间和输出路径后，可周期运行外部报告。

## 设计思路

- **定性档既能表达意图，又不必精确报分钟。** “等会儿”和“今晚”比裸分钟数更接近真实想法。插件把档位映射成时间后再夹紧，防止 agent 选“五分钟后”绕过最短间隔。
- **硬额度保护成本和注意力。** 每次唤醒都是完整模型回合。滚动时间窗加硬上限比依赖 agent 自觉更可靠；夜间模式只改变节奏，不取消天花板。
- **唤醒必须走真实回合。** 直接调裸 LLM 会丢人设、记忆、当前心情和工具。`followup()` 进入正常 agent 循环，因此可以想事、总结、联系运维方、看群，也可以什么都不做。
- **排期防御、空转后退、无会话要明确。** 没调用 `heartbeat_next`、抛异常、系统休眠或定时器丢失，都会由唤醒后兜底和巡检补回排期。连续短间隔空转会向更长档后退；默认没有活会话就跳过并重排，必须显式 `allowSolo` 才创建专用会话。

## 配置

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `enabled` | `true` | 设为 `false` 时禁用插件。 |
| `minGapMinutes` | `90` | 普通档的最短间隔分钟数。 |
| `maxGapMinutes` | `900` | 普通档的最长间隔分钟数。 |
| `dailyCap` | `8` | 滚动 24 小时唤醒硬上限。 |
| `nightStartHour` | `22` | 夜间额外额度的开始小时。 |
| `nightEndHour` | `8` | 夜间额外额度的结束小时。 |
| `nightIntervalFactor` | `1.25` | 夜间间隔的放大系数。 |
| `nightExtraCap` | `2` | 夜间额外唤醒次数。 |
| `ownerName` | `主人` | 心跳提示中使用的主人称呼。 |
| `dir` | `~/.koi` | 状态和心跳日志目录。 |
| `workspaceDir` | `~/.dsh-qqbot/workspace` | 自建独处会话的工作目录。 |
| `provider` | 空 | 自建会话的显式 provider。 |
| `model` | 空 | 自建会话的显式 model。 |
| `allowSolo` | `false` | 无活 agent 时是否允许创建专用心跳会话。 |
| `maxTokens` | `700` | 保留的兼容键；当前代码会解析它，但不会传给 `followup()`。 |
| `debug` | `true` | 输出详细排期诊断。 |
| `leakReport.enabled` | `false` | 是否启用可选周期报告。 |
| `leakReport.script` | `tools/leak-check.mjs` | 相对仓库根的报告脚本路径。 |
| `leakReport.output` | `ops/leak-weekly.log` | 只追加报告输出路径。 |
| `leakReport.everyMs` | `604800000` | 两次报告之间的最小间隔。 |
| `leakReport.until` | 无截止 | ISO 截止时间，过期后停止报告定时器。 |
| `leakReport.args` | `[]` | 传给报告脚本的参数。 |

## 接口

| 名称 | 类型 | 作用 |
| --- | --- | --- |
| `koi-heartbeat` | 插件 id | 包导出的挂载名。 |
| `agents`, `tools` | 注入服务 | follow-up 回合和心跳工具注册所必需。 |
| `heartbeat_next` | 工具 | 用定性档安排下一次唤醒。 |
| `heartbeat_status` | 工具 | 报告下次唤醒和滚动 24 小时次数。 |
| `agent.followup()` | 宿主调用 | 启动完整心跳回合。 |
| 定时器、唤醒后兜底、巡检 | 定时器 | 触发、修复或恢复唤醒排期。 |
| `heartbeat.json`, `heartbeat.log.jsonl` | 状态文件 | 保存排期状态，并追加唤醒/计划日志。 |

## 验证

在仓库根目录运行：

```bash
node plugins/dsh-koi-heartbeat/test-heartbeat-regressions.mjs
```

测试逐条打印 `✅` 或 `❌`，结束时输出 `N 通过 / 0 失败`；全部通过时退出码为 `0`。

## 说明 / 限制

- 定时器存在于 agent 进程内。巡检只能修复进程内漏触发，不能让未运行的进程自行恢复。
- 滚动额度基于保存的唤醒时间戳，不是本地自然日计数器。
- `allowSolo: false` 时，插件不会为了维持心跳而自行创建额外 agent。
- 显式 provider/model 优先；否则自建会话会继承面板固定路由或活会话。都没有时跳过本次心跳。
- `followup()` 同步抛错不会消耗唤醒额度。
- `maxTokens` 在当前实现中没有实际运行效果；心跳生成预算不由这个键控制。
