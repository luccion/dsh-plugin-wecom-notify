# wecom-turn-notify

> DSH 每轮对话结束时，向企业微信群机器人 Webhook 推送通知 —— 提醒颗粒度可选四档。

[English](#english) | 中文

[DSH (DeepSeek Harness)](https://github.com/deepseek-ai/deepseek-harness) 宿主插件。挂在 durable 的
`turn/end` 会话事件上，所以正常结束、出错、被中止、达到输出上限都会通知，并带上结束原因。

- **四档颗粒度**：`status`（只发状态行）/ `normal`（状态 + 摘要）/ `detailed`（更长摘要 + 过程统计）/
  `smart`（**调用子智能体压成限字简报**）。
- **只出站**：DSH 主动 POST 到企业微信的 `qyapi.weixin.qq.com`，不需要公网服务器、域名或回调配置。
- **不拖慢对话**：事件回调里只做「排期」，发送与总结都在串行/并行队列里延后执行。
- **默认只通知顶层会话**：subagent / workflow 子代理的每一轮不会打扰你。
- **抗限流**：默认 1.5s 静默合并、两次发送至少间隔 3s、失败重试 3 次。
- **密钥不外泄**：日志里只有脱敏后的 URL（`key=***`）。

## 四档提醒颗粒度

| `mode` | 消息内容 | 额外开销 |
|---|---|---|
| `status` | 只有标题行：会话 / 第几轮 / 结果 / 时间 | 无 |
| `normal`（默认） | status + 本轮助手文本，截断到 1200 字节 | 无 |
| `detailed` | 更长的摘要（3500 字节）+ `**过程**：N 步 · M 次工具调用（K 次失败）`；失败轮次附排查提示 | 无 |
| `smart` | 调用子智能体把本轮压成 ≤140 字简报（可配），附过程统计；失败自动退回截断 | 一次子智能体会话，约数秒 |

`status` 是这样的：

```
## ✅ DSH 对话完成
> **会话**：修复登录问题
> **会话 ID**：session-2b43...
> **状态**：第 3 轮 · 已完成 · 2026-10-08 09:41:02
```

`smart` 是这样的（正文由子智能体写、字数由插件强制回收）：

```
## ✅ DSH 对话完成
> **会话**：修复登录问题
> **会话 ID**：session-2b43...
> **状态**：第 3 轮 · 已完成 · 2026-10-08 09:41:02
> **过程**：4 步 · 7 次工具调用

登录校验已改好，测试全绿，无遗留风险。
>
> _子智能体总结 · ≤140 字_
```

### 关于 `smart`

- 送的是一次 **one-shot 子智能体** 调用：`provider: spawn`（可改 `fork`）、**不给任何工具**
  （`toolFilter: { allow: [] }`）、`maxDepth: 1`、带一段「只做压缩」的 persona。
- 字符上限由插件兜底：即使模型写超了也会被裁到 `summaryChars`（填 `"model"` 则交给模型自己的限制）。
- **代价**：每轮一次额外模型调用，并且会在 DSH 里多出一个 `wecom-summary` 子会话行（受 `rootsOnly`
  过滤，它自己不会再触发通知）。想省就留在 `normal` / `detailed`。
- 任何失败（服务缺失、超时、模型报错、返回空）都不会丢通知：正文退回本地截断，并在消息里标注
  `智能总结不可用（原因），已退回截断`。

## 安装

```bash
# 1. 先拿到源码（这步不能省：插件自身依赖要从这里装）
git clone https://github.com/luccion/dsh-plugin-wecom-notify
cd dsh-plugin-wecom-notify
pnpm install

# 2. 装进你的 DSH profile
dsh plugin --profile <你的 profile 名> install "$(pwd)"
```

> 第 1 步的 `pnpm install` 是必需的：DSH 用 `link:` 把插件挂进 profile，而插件的
> `import '@deepseek-ai/schemastery'` 会从**克隆目录**解析。跳过它就会看到 “failed to import”。
>
> 想锁版本可以用 tag：`git clone --branch v0.1.0 https://github.com/luccion/dsh-plugin-wecom-notify`

装完在 DSH 的 **Plugins** 页能看到 `dsh-plugin-wecom-turn-notify`，可以开关、删除，也能直接在
它的配置表单里改（`mode` 会渲染成下拉框）。热重载生效，不需要重启。

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
    mode: 'smart'          # status | normal | detailed | smart
    summaryChars: 140      # 数字，或 "model"
```

改完热重载立即生效。

## 配置项

| 字段 | 默认 | 说明 |
|---|---|---|
| `webhookUrl` | `''` | 企业微信群机器人 Webhook。留空时只写诊断日志、不发送。 |
| `enabled` | `true` | 总开关。 |
| `mode` | `normal` | 提醒颗粒度：`status` / `normal` / `detailed` / `smart`。 |
| `heading` | `DSH 对话完成` | 消息一级标题（前面会自动加 ✅ / ❌ / ⚠️）。 |
| `rootsOnly` | `true` | 只通知顶层会话；关掉后子代理的每一轮也会通知。 |
| `mentionList` | `[]` | 要 @ 的手机号数组；填 `"@all"` 表示 @所有人。 |
| `includeText` | `true` | 是否附带本轮助手文本（`status` 档本来就不发正文）。 |
| `maxContentBytes` | `0` | 摘要字节上限；`0` 表示用当前档位默认值（normal 1200 / detailed 3500）。 |
| `summaryChars` | `140` | `smart` 档简报的字数上限；填 `"model"` 表示交给模型自己的限制。 |
| `summaryProvider` | `spawn` | `smart` 档用哪个子智能体 provider（`spawn` 干净新起 / `fork` 分叉上下文）。 |
| `summaryModel` | `''` | `smart` 档使用的模型；留空用子智能体默认路由。 |
| `summaryTimeoutMs` | `60000` | 总结超时；超时后本条退回本地截断。 |
| `debounceMs` | `1500` | 每轮结束后的静默合并窗口。 |
| `minIntervalMs` | `3000` | 两次发送的最小间隔（规避企业微信 20 条/分钟限流）。 |
| `timeoutMs` | `8000` | 单次 HTTP 请求超时。 |
| `attempts` | `3` | 总尝试次数；`93000/40001/40008`（密钥或报文问题）不重试。 |
| `debugLog` | `false` | `true` 写到插件目录的 trace 日志，或给一个绝对路径；用来确认插件是否真的挂上。 |

## 排障

1. 打开 `debugLog`（给一个绝对路径），触发一轮对话，然后看 trace：
   - 没有 trace 文件 → 条目没挂载（Plugins 页看该行是否 active）；
   - 有 `apply() entered` 但没有 `turn/end` → 事件没到（确认 `enabled`，以及被 `rootsOnly` 过滤的情况）；
   - `summary failed ...` → `smart` 档总结失败，看括号里的原因；
   - 有 `turn/end` 但 `sent ... failed: ...` → 看失败原因（Webhook key、网络、企业微信返回码）。
2. 群里没消息：确认这条 Webhook 对应的群就是你正在看的群，且机器人没被移出群。
3. 企业微信机器人只接受 `msgtype: markdown` 且正文 ≤ 4096 字节，本插件按 3800 字节截断。
4. 需要通过代理访问外网时，`fetch` 不读 `HTTP_PROXY`；这种情况请把 Webhook 指向一个本地可直连的转发端点。

## 开发

```bash
pnpm install          # 唯一的运行时依赖是 @deepseek-ai/schemastery
node test/run.mjs     # 23 项：脱敏、截断、轮次统计、四档组装、总结提示词、发送与重试
node test/apply.mjs   # 19 项：apply() 接线、事件去重、四档分发、子智能体调用与降级、配置 schema
```

```
.
├── index.js            # Cordis 插件入口（name / Config / apply、档位分发、子智能体总结）
├── lib/notify.js       # 纯函数：脱敏、截断、读会话日志与轮次统计、markdown 组装、总结提示词、发送
├── cordis.patch.yml    # bundle patch：只插入一行 wecom-turn-notify
├── test/
└── package.json        # dsh.bundle.patch 指向 cordis.patch.yml
```

改动插件代码后，需要让该行重新挂载一次才会加载新代码（Plugins 页关掉再打开，或做一次无实质的
patch 编辑）。桌面版目前不会因为模块文件变化自动替换已加载的代码。

## 实现要点

- 监听 `session/event`（`turn/end`）与 `agent/turn-stopping` 两个事件。同一轮会先后到达两次，
  插件用 `sessionId → turn` 去重合并，只发一条，并保留 `turn/end` 里更准确的结束原因。
- `apply()` 里不 await 任何网络操作：事件回调只 `setTimeout` 排期，发送在串行队列里按
  `minIntervalMs` 节流；`smart` 档的总结在入队前**并行**执行（因为那时父 Agent 还活着，队列里发消息
  不需要它），且仅在真的会发送时才触发。
- 总结失败永不丢通知：退回本地截断并标注原因。
- 发送走 Node 内置 `fetch`，带 `AbortSignal.timeout`；密钥类错误直接放弃重试。
- 根会话判定用 `ctx.agents.roots()`；注册表不可用时退化为「都通知」，不会静默丢消息。

## 兼容性

在 DSH `0.2.0-rc.2` + Node 24 上开发与验证（含真实端到端投递：企业微信返回 `errcode: 0`）。
插件不声明任何 DSH peer 依赖，只依赖 `@deepseek-ai/schemastery`（用来声明配置 schema）。

## License

[MIT](LICENSE)

---

<a id="english"></a>
## English

A DSH (DeepSeek Harness) host plugin that posts a WeCom (WeChat Work) group-robot markdown
message whenever one conversation turn finishes, at one of four detail levels.

```bash
git clone https://github.com/luccion/dsh-plugin-wecom-notify
cd dsh-plugin-wecom-notify && pnpm install
dsh plugin --profile <profile> install "$(pwd)"
```

The `pnpm install` step is required: DSH links the plugin into the profile, and the plugin's
own `import '@deepseek-ai/schemastery'` resolves from the clone. Pin a release with
`git clone --branch v0.1.0 …`.

| `mode` | What the message carries |
|---|---|
| `status` | One status line: session, turn, outcome, time — no body. |
| `normal` (default) | Status line plus the turn's assistant text, truncated to 1200 bytes. |
| `detailed` | Longer excerpt (3500 bytes) plus a process line: steps, tool calls, failures. |
| `smart` | A subagent-written digest capped at 140 characters, plus the process line. |

`smart` runs one one-shot subagent per notified turn (provider `spawn` by default, **no tools**,
`maxDepth: 1`, a summarizer persona). The character cap is enforced by the plugin even when the
model overshoots, and any failure degrades to local truncation with the reason shown in the
message — a notification is never lost. Expect one extra model call and one extra
`wecom-summary` child session row per turn.

- Outbound only — it POSTs to `qyapi.weixin.qq.com`; no public server, domain, or callback setup.
- Non-blocking: events only schedule work; a serialized queue performs the HTTP sends.
- Top-level sessions only by default, so subagent turns stay quiet.
- Debounce (1.5s), rate-limit spacing (3s) and 3 retries by default; the webhook key is redacted in logs.
- Configure `webhookUrl` and `mode` from the Plugins page or a `cordis.patch.yml` override.
