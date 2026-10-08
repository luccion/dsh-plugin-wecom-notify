# wecom-turn-notify

> DSH 每轮对话结束时，向企业微信群机器人 Webhook 推送通知。

[English](#english) | 中文

[DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) 宿主插件。挂在 durable 的
`turn/end` 会话事件上，所以正常结束、出错、被中止、达到输出上限都会通知，并带上结束原因与
本轮最后的助手文本摘要。

- **只出站**：DSH 主动 POST 到企业微信的 `qyapi.weixin.qq.com`，不需要公网服务器、域名或回调配置。
- **不拖慢对话**：事件回调里只做「排期」，真正发送在一条串行队列里延后执行。
- **默认只通知顶层会话**：subagent / workflow 子代理的每一轮不会打扰你。
- **抗限流**：默认 1.5s 静默合并（同一会话连续轮次合成一条）、两次发送至少间隔 3s、失败重试 3 次。
- **密钥不外泄**：日志里只有脱敏后的 URL（`key=***`）。

消息长这样：

```
## DSH 对话完成
> **会话**：修复登录问题
> **会话 ID**：session-2b43...
> **状态**：第 3 轮 · 已完成 · 2026-10-08 09:41:02

已经改好并跑过测试了。
```

## 安装

```bash
dsh plugin --profile <你的 profile 名> install https://github.com/luccion/dsh-plugin-wecom-notify
```

装完在 DSH 的 **Plugins** 页能看到 `dsh-plugin-wecom-turn-notify`，可以开关、删除，也能直接在
它的配置表单里改 Webhook（配置 schema 会投影到设置页）。热重载生效，不需要重启。

卸载：

```bash
dsh plugin --profile <profile> remove dsh-plugin-wecom-turn-notify
```

## 配置 Webhook

企业微信群机器人 Webhook 在**群聊**里拿：群聊 → ⋯（聊天信息）→ **消息推送**（旧版叫「群机器人」）
→ 添加 → 复制自动生成的地址，形如：

```
https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx
```

> 注意别和管理后台的「应用管理 → 自建应用 → 接收消息」搞混：那是**企业微信回调你**的方向，
> 需要公网 URL + Token + EncodingAESKey。本插件只用群机器人地址，不需要那些。

改 Webhook 有两种方式：Plugins 页的配置表单，或在 profile 的 `cordis.patch.yml` 里覆盖该行：

```yaml
- id: wecom-turn-notify
  name: 'dsh-plugin-wecom-turn-notify'
  config:
    webhookUrl: 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=你的KEY'
```

改完热重载立即生效。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `webhookUrl` | `''` | 企业微信群机器人 Webhook。留空时只写诊断日志、不发送。 |
| `enabled` | `true` | 总开关。 |
| `heading` | `DSH 对话完成` | 消息一级标题。 |
| `rootsOnly` | `true` | 只通知顶层会话；关掉后子代理的每一轮也会通知。 |
| `mentionList` | `[]` | 要 @ 的手机号数组；填 `"@all"` 表示 @所有人。 |
| `includeText` | `true` | 是否附带本轮最后的助手文本摘要。 |
| `maxContentBytes` | `1200` | 摘要字节上限。 |
| `debounceMs` | `1500` | 每轮结束后的静默合并窗口。 |
| `minIntervalMs` | `3000` | 两次发送的最小间隔（规避企业微信 20 条/分钟限流）。 |
| `timeoutMs` | `8000` | 单次请求超时。 |
| `attempts` | `3` | 总尝试次数；`93000/40001/40008`（密钥或报文问题）不重试。 |
| `debugLog` | `false` | `true` 写到插件目录的 trace 日志，或给一个绝对路径；用来确认插件是否真的挂上。 |

## 排障

1. 打开 `debugLog`（给一个绝对路径），触发一轮对话，然后看 trace：
   - 没有 trace 文件 → 条目没挂载（Plugins 页看该行是否 active）；
   - 有 `apply() entered` 但没有 `turn/end` → 事件没到（确认 `enabled`，以及被 `rootsOnly` 过滤的情况）；
   - 有 `turn/end` 但 `sent ... failed: ...` → 看失败原因（Webhook key、网络、企业微信返回码）。
2. 群里没消息：确认这条 Webhook 对应的群就是你正在看的群，且机器人没被移出群。
3. 企业微信机器人只接受 `msgtype: markdown` 且正文 ≤ 4096 字节，本插件按 3800 字节截断。
4. 需要通过代理访问外网时，`fetch` 不读 `HTTP_PROXY`；这种情况请把 Webhook 指向一个本地可直连的转发端点。

## 开发

```bash
pnpm install          # 唯一的运行时依赖是 @deepseek-ai/schemastery
node test/run.mjs     # 13 项：脱敏、截断、日志读取、markdown 组装、发送与重试
node test/apply.mjs   # 10 项：apply() 接线、事件去重、rootsOnly 过滤、配置 schema
```

```
.
├── index.js            # Cordis 插件入口（name / Config / apply）
├── lib/notify.js       # 纯函数：脱敏、截断、读会话日志、markdown 组装、发送
├── cordis.patch.yml    # bundle patch：只插入一行 wecom-turn-notify
├── test/
└── package.json        # dsh.bundle.patch 指向 cordis.patch.yml
```

改动插件代码后，需要让该行重新挂载一次才会加载新代码（Plugins 页关掉再打开，或做一次无实质的
patch 编辑）。

## 实现要点

- 监听 `session/event`（`turn/end`）与 `agent/turn-stopping` 两个事件。同一轮会先后到达两次，
  插件用 `sessionId → turn` 去重合并，只发一条，并保留 `turn/end` 里更准确的结束原因。
- `apply()` 里不 await 任何网络操作：事件回调只 `setTimeout` 排期，发送在串行队列里按
  `minIntervalMs` 节流。
- 发送走 Node 内置 `fetch`，带 `AbortSignal.timeout`；密钥类错误直接放弃重试。
- 根会话判定用 `ctx.agents.roots()`；注册表不可用时退化为「都通知」，不会静默丢消息。

## 兼容性

在 DSH `0.2.0-rc.2` + Node 24 上开发与验证（含一次真实的端到端投递：企业微信返回 `errcode: 0`）。
插件不声明任何 DSH peer 依赖，只依赖 `@deepseek-ai/schemastery`（用来声明配置 schema）。

## License

[MIT](LICENSE)

---

<a id="english"></a>
## English

A DSH (DeepSeek Harness) host plugin that posts a WeCom (WeChat Work) group-robot markdown
message whenever one conversation turn finishes.

```bash
dsh plugin --profile <profile> install https://github.com/luccion/dsh-plugin-wecom-notify
```

- Outbound only — it POSTs to `qyapi.weixin.qq.com`; no public server, domain, or callback setup.
- Non-blocking: events only schedule work; a serialized queue performs the HTTP sends.
- Top-level sessions only by default, so subagent turns stay quiet.
- Debounce (1.5s), rate-limit spacing (3s) and 3 retries by default; the webhook key is redacted in logs.
- Configure `webhookUrl` from the Plugins page or a `cordis.patch.yml` override.
