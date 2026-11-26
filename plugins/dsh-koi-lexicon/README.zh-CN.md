# dsh-koi-lexicon

中文 | [English](./README.md)

维护 agent 的身份锚点，以及它对人物、物事、事件和自己后来认下之事的长期主观记录。

## 它做什么

- 把旧人设卡和 affect 数据一次性迁入统一的 `lexicon.json`，迁完不改源文件。
- 以只读 core、自认的 self、按稳定 id 或名字识别人物、按规整文本识别物事，组成一套词条。
- 追加 V3 的 `desc` 与 `impression`，按每条自己的曲线现算当前值。
- 以运行时上下文快照注入当前说话人和主观世界；核心身份作为系统段保留。
- 提供描述、印象、清零重来、回想、状态，以及“把自我条目搁到一边”的工具。
- 记录配置名字当天是否被提到；被提到的人可以优先露头，但不会因此改分数。

## 设计思路

- **让冲突的社会状态只有一个所有者。** 人设卡和 affect 曾分别描述同一个人，提示词里会出现互相矛盾的说法。统一后，“这人是什么样”和“我现在怎么看 TA”都从同一份状态模型读取。
- **V3 把描述和印象拆开。** 描述回答“某人或某物是什么样”，印象由短的 `face` 加正负 `delta` 组成。两者有独立记录，印象不会因为最近一条描述淡掉就一起消失。
- **描述有三个展示态，淡掉不等于删掉。** `clear` 显示完整描述，`fading` 降级成具体钩子，`forgotten` 只保留钩子或提示先 recall。钩子取当前权重最高的原始描述，不重新生成也不摘要；显示阈值只决定注不注入，被取代的 traits 只打 `superseded`，reset 后的印象标 `voided`，muted 记录也仍在历史里并可由 recall 取出。
- **代码不替 agent 做语义分类。** 2026-11-26 她选择方案 A：只保留一个默认曲线，由 agent 在写入时自己判断这是人还是物事、是描述还是印象。`item.type` 只是存储标签，不是第二套分类器；新 V3 条目默认共用 40 天半衰期，只有关系上限会收紧显式曲线。
- **用户可控键必须防原型污染。** `__proto__`、`prototype`、`constructor` 等名字直接拒绝；`people` 和 `things` 使用无原型映射并只读写自有键，避免模型输入污染 `Object.prototype`。
- **重复证据按并集概率合并。** 同一 `face` 的多条印象会饱和增长，不会线性超过 1。这样能区分“许多弱观察”和“一条极端观察”，也不需要静默硬截断。
- **关系档位限制滥用。** 当前关系判定只区分陌生人与熟人，最长半衰期分别夹到 14 天和 60 天。写入前就会夹紧参数，防止陌生人一条敌意消息种下一年期的记恨。owner/self 的档位常量仍在表里，但当前 `relationOf()` 路径不会选中它们。
- **迁移和损坏都显式处理。** 旧数据只迁一次且源文件不动；`lexicon.json` 损坏时先备份并禁止写回。正常写入使用重新读取、原子临时文件、fsync 和 rename。

## 配置

| 键 | 默认值 | 作用 |
| --- | --- | --- |
| `dir` | 解析后的 KOI 数据目录 | 词条和默认文件的基础目录。 |
| `platform` | `unknown` | 写入 V3 identity 的平台标签。 |
| `selfName` | 空 | 额外视为 agent 自己的名字。 |
| `cardFile` | `<dir>/profile.persona.md` | 一次性迁移使用的旧人设卡。 |
| `coreFile` | `<dir>/profile.core.md` | 在词条前注入的只读核心身份。 |
| `maxPeople` | `40` | V3 主人物段最多渲染多少人。 |
| `maxThings` | `40` | V3 最多渲染多少物事条目。 |
| `descPerPerson` | `2` | 每个人最多渲染几条清晰描述。 |
| `migrateFromAffect` | `true` | 是否迁入旧 affect 中的喜恶与人物。 |
| `useV3` | 代码默认 `false`；随包 patch 设为 `true` | 选择 V3 条目渲染，还是旧 traits/history 路径。 |

环境变量 `KOI_AGENT_NAME` 也可追加一个自我称呼。

## 接口

| 名称 | 类型 | 作用 |
| --- | --- | --- |
| `koi-lexicon` | 插件 id | 包导出的挂载名。 |
| `tools` | 注入服务 | 注册工具所必需。 |
| `agent/inbox/claimed` | 事件订阅 | 在提示词组装前更新当前说话人。 |
| `session/event` | 事件订阅 | 记录真人发言、互动轮数和当天被提到状态。 |
| `system-prompt/assemble` | 事件订阅 | 加入说话人和主观世界段。 |
| `koi:speaker` | 运行时上下文快照 | 短期有效的当前说话人证据。 |
| `koi:lexicon` | 运行时上下文快照 | core、self 补充、人物、喜恶和心情记录。 |
| `remember_person` | 工具 | 追加一个人的描述。 |
| `remember_impression` | 工具 | 追加或清零人物/物事印象。 |
| `set_aside` | 工具 | 隐藏或恢复自己认下的条目，不删除。 |
| `recall` | 工具 | 查印象、描述、事实、短期消息和归档旧账。 |
| `lexicon_status` | 工具 | 汇总当前对人与物的态度。 |

## 验证

在仓库根目录运行：

```bash
for f in plugins/dsh-koi-lexicon/test-*.mjs; do node "$f" || exit 1; done
```

测试逐条打印 `✅` 或 `❌`，结束时输出 `N 通过 / 0 失败`。退出码为 `0` 表示所选测试全部通过。

## 说明 / 限制

- `useV3: false` 时走旧 traits/history 渲染；随包 patch 明确开启了 V3。
- `recall` 是字面 token 匹配，要求查询中的词全部命中，不是语义搜索。
- 本包不使用 owner id 做权限门。主人身份仍是可由更完整语境纠正的主观上下文；随包 patch 里的 `ownerOid` 当前实现没有读取。
- `memory_add(scope="self")` 和 `memory_add(scope="core")` 写入本包的 `lexicon.json`；对 core 的自述补充不会修改只读 core 文件。
- 读改写 API 没有跨进程锁。原子替换可防止半文件，但并发写仍以最后完成的版本为准。
