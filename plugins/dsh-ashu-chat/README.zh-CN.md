# dsh-ashu-chat

中文 | [English](./README.md)

宿主侧的 Pisces 聊天面板：在主人与对端 agent 之间提供一条直接、带签名的 JSONL 对话线。

## 功能

- 注册左栏 **Pisces 聊天**入口及其 `/pisces-chat/*` 后端路由。
- 只读取最近 80 条 `master` 发给 `koi` 或 `koi` 发给 `master` 的消息。
- 通过共享 `chat-store` 把主人消息追加到 `<KOI_HOME>/.koi/chat.jsonl`，标记 `via: "panel"`，并在 `chat.key` 可用时签名。
- 接收最大 20 MiB 的上传，保存到 `.koi/workspace/uploads`，再追加一条带文件元信息的消息。
- 只从 `.koi/workspace` 子树提供文件下载；遇到不可读记录时报告降级状态，而不是把通道伪装成空文件。

## 设计思路

面板把“主人 ↔ 对端 agent”与另一条 agent 间对话分开，因此两个方向都要求明确的 `to`。否则，只在正文写 `from: "master"`、却不标收件人的记录会作为主人发言混进错误的面板。

面板不管理、也不删除会话。会话创建属于聊天层；硬造或硬删会话会破坏运行数据。这里只显示共享文件通道，并向其中追加消息。

签名只能证明消息来自本机，不能证明是哪个人敲的：主人和本机 agent 可以使用同一把 key。`via: "panel"` 补充来源信息，真实用户身份仍由 Web 登录负责。

20 MiB 上传上限在 `readBody` 的流式读取阶段执行。请求读取器逐块计数字节，在拼接超限请求体之前直接返回 HTTP 413，并为 base64 膨胀预留请求体空间；解码后的真实字节数在写盘前再检查一次。先完整缓冲再校验、以及只相信浏览器端的 `File.size`，都会带来不必要的内存占用或可绕过的服务端限制，因此没有采用。

代价是 base64 传输开销和固定的 20 MiB 上限。下载统一以 `application/octet-stream` 返回，面板也不提供删除消息或管理会话的能力。

## 配置

| 键 | 默认值 | 作用 |
|---|---|---|
| `koiHome` | `$KOI_HOME`，否则 `$HOME/koi` | 存放 `.koi/chat.jsonl`、`.koi/chat.key` 与 `.koi/workspace` 的根目录。 |

## 接口

- 包 id：`dsh-ashu-chat`。
- Bundle 条目 id：`ashu-chat-config`；运行时插件名：`ashu-chat`。
- HTTP 路由：

| 方法 | 路由 | 用途 |
|---|---|---|
| `GET` | `/pisces-chat/state` | 返回最近消息、聊天文件路径、坏行数和读取状态。 |
| `POST` | `/pisces-chat/upload` | 接收 `{ name, data, text? }`，保存文件并追加一条消息。 |
| `GET` | `/pisces-chat/file?rel=...` | 下载 `.koi/workspace` 下的文件。 |
| `POST` | `/pisces-chat/send` | 把 `{ text, kind? }` 作为签名的 `master` → `koi` 消息追加到通道。 |

- 不注册工具或宿主事件。
- 依赖服务：`webServer`；复用 `dsh-koi-chat` 的签名与 chat-store 模块。

## 验证

```bash
cd <repo>
node plugins/dsh-ashu-chat/test-append.mjs
```

预期：输出 `6 通过 / 0 失败`，退出码为 0。

## 说明与限制

- 面板只展示最近 80 条消息，更早的合法消息仍保留在 JSONL 文件中。
- 该通道没有推送传输，浏览器每五秒轮询 `/pisces-chat/state`。
- 面板不创建、删除会话，也不清理附件。
- 文件路由按路径前缀限制在 workspace 子树内，但不扫描上传内容。
- key 缺失或签名失败时会记录日志并退化为未签名消息，不会阻断发送。
