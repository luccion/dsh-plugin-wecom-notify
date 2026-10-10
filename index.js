/**
 * WeCom (企业微信) turn-completion notifications.
 *
 * The plugin watches every finished conversation turn and posts a markdown
 * message to one WeCom group-robot webhook, at one of four detail levels:
 * `status`, `normal`, `detailed`, or `smart` (a subagent-written digest).
 *
 * It is deliberately non-blocking on the agent path: events only schedule work,
 * and delivery happens later on a serialized queue so a slow webhook or a slow
 * summarizer can never stall a turn.
 *
 * @module dsh-plugin-wecom-turn-notify
 */
import Schema from '@deepseek-ai/schemastery'
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  MODE_DEFAULTS,
  MODE_LABELS,
  MODES,
  WEBHOOK_MAX_BYTES,
  composeMarkdown,
  composeSummaryPrompt,
  readLastAssistantText,
  readSessionTitle,
  readTurnStats,
  redactWebhook,
  sendWeComMessage,
  truncateChars,
} from './lib/notify.js'

/** Cordis plugin name. */
export const name = 'wecom-turn-notify'

/**
 * LOCAL PATCH (2026-10-08): declare the service this plugin uses.
 * Cordis refuses `ctx.<service>` access for a service the plugin never injected, and
 * DSH escalates that uncaught error to a fatal host exit (`fatal load failure`), which
 * took down the whole desktop app on every notification. DSH's own subagent consumers
 * declare exactly `inject: ['subagents']`.
 */
export const inject = ['subagents']

/** Notification detail level, rendered as a dropdown in the Settings UI. */
const ModeSchema = Schema.union(MODES.map((mode) => Schema.const(mode).description(MODE_LABELS[mode])))
  .default('normal')
  .description('提醒颗粒度：仅状态汇报 / 普通 / 详细 / 智能总结。')

const SummaryChars = Schema.union([Schema.natural(), Schema.const('model')])
  .default(140)
  .description('智能总结的字数上限：数字表示硬上限，填 "model" 表示交给子智能体自己的限制决定。')

/** Live configuration. */
export const Config = Schema.object({
  webhookUrl: Schema.string()
    .default('')
    .description('企业微信群机器人 Webhook 地址（https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...）。留空则只记录日志、不发送。'),
  enabled: Schema.boolean()
    .default(true)
    .description('是否启用通知。'),
  mode: ModeSchema,
  heading: Schema.string()
    .default('DSH 对话完成')
    .description('消息标题（WeCom markdown 的一级标题）。'),
  rootsOnly: Schema.boolean()
    .default(true)
    .description('只通知顶层会话；关闭后 subagent / workflow 子代理的每一轮也会通知。'),
  mentionList: Schema.array(Schema.string())
    .role('table')
    .default([])
    .description('需要 @ 的成员手机号；填 "@all" 表示 @所有人。'),
  includeText: Schema.boolean()
    .default(true)
    .description('是否附带本轮助手文本（status 档本来就只发状态行，不受此项影响）。'),
  maxContentBytes: Schema.natural()
    .role('ms')
    .default(0)
    .description('摘要字节上限；0 表示用当前 mode 的默认值（normal 1200 / detailed 3500）。'),
  summaryChars: SummaryChars,
  summaryProvider: Schema.union([Schema.const('spawn').description('新建一个干净的子智能体（默认）。'), Schema.const('fork').description('分叉当前会话上下文，通常更慢更贵。')])
    .default('spawn')
    .description('智能总结用哪个子智能体 provider。'),
  summaryModel: Schema.string()
    .default('')
    .description('智能总结使用的模型；留空则用子智能体默认路由（例如 deepseek-flash）。'),
  summaryTimeoutMs: Schema.natural()
    .role('ms')
    .default(60000)
    .description('智能总结的超时；超时后本条退回本地截断。'),
  debounceMs: Schema.natural()
    .role('ms')
    .default(1500)
    .description('每轮结束后的静默等待；期间同一会话的更新轮次会合并成一条消息。'),
  minIntervalMs: Schema.natural()
    .role('ms')
    .default(3000)
    .description('两次发送之间的最小间隔，用于规避企业微信 20 条/分钟的限流。'),
  timeoutMs: Schema.natural()
    .role('ms')
    .default(8000)
    .description('单次 HTTP 请求超时。'),
  attempts: Schema.natural()
    .role('ms')
    .default(3)
    .description('发送失败时的总尝试次数。'),
  debugLog: Schema.union([Schema.boolean(), Schema.string()])
    .default(false)
    .description('诊断用：true 写到插件目录下的 trace 日志，或直接给出日志文件路径；默认关闭。'),
})

/**
 * Resolve the optional activation-trace file.
 * @param {object} config - validated configuration.
 * @returns {string} an absolute path, or '' when tracing is off.
 */
function resolveTracePath(config) {
  if (typeof config.debugLog === 'string' && config.debugLog !== '') return config.debugLog
  if (config.debugLog !== true) return ''
  try {
    return join(dirname(fileURLToPath(import.meta.url)), 'wecom-turn-notify.trace.log')
  } catch {
    return ''
  }
}

/**
 * Build the trace sink.
 * @param {string} path - target file, or '' to disable tracing.
 * @returns {(line: string) => void} a never-throwing append.
 */
function makeTrace(path) {
  if (path === '') return () => { }
  return (line) => {
    try {
      appendFileSync(path, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // a trace failure must never affect the turn
    }
  }
}

/** Collect the text of a content-block array, the shape a subagent returns. */
function blocksToText(blocks) {
  if (!Array.isArray(blocks)) return ''
  const parts = []
  for (const block of blocks) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Install the notification listener.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the owning plugin context.
 * @param {object} config - validated configuration.
 */
export function apply(ctx, config) {
  const webhook = typeof config.webhookUrl === 'string' ? config.webhookUrl.trim() : ''
  const displayUrl = redactWebhook(webhook)
  const mode = MODES.includes(config.mode) ? config.mode : 'normal'
  const profile = MODE_DEFAULTS[mode]
  const excerptBytes = typeof config.maxContentBytes === 'number' && config.maxContentBytes > 0
    ? config.maxContentBytes
    : profile.excerptBytes
  const summaryChars = config.summaryChars === 'model' ? 'model' : Number(config.summaryChars)
  const trace = makeTrace(resolveTracePath(config))

  /**
   * LOCAL PATCH (2026-10-08): non-throwing Cordis service lookup.
   * Cordis throws `cannot get property "<name>" without inject` for a service the plugin
   * never declared, and DSH escalates that uncaught error to a fatal host exit. With
   * `inject` declared, `ctx.<name>` is the primary accessor; the reader-style fallbacks
   * cover loaders where only those resolve. Every attempt is guarded, so a missing service
   * degrades the digest instead of killing the host.
   * @param {string} name - service key.
   * @returns {any} the live service, or undefined.
   */
  function readService(name) {
    const readers = [
      () => ctx[name],
      () => ctx.reflect?.get?.(name),
      () => (typeof ctx.get === 'function' ? ctx.get(name) : undefined),
    ]
    for (const read of readers) {
      try {
        const value = read()
        if (value !== undefined && value !== null) return value
      } catch {
        // unusable accessor; try the next one
      }
    }
    return undefined
  }

  /** Report which accessor resolves a service, for the activation trace. */
  function probeAccessors(name) {
    const report = []
    const check = (label, read) => {
      try {
        const value = read()
        report.push(`${label}=${value === undefined || value === null ? 'undef' : (typeof value.start === 'function' ? 'ok' : 'obj')}`)
      } catch {
        report.push(`${label}=throw`)
      }
    }
    check('prop', () => ctx[name])
    check('reflect', () => ctx.reflect?.get?.(name))
    check('get', () => (typeof ctx.get === 'function' ? ctx.get(name) : undefined))
    return report.join(',')
  }

  trace(`apply() entered; build=local-patch-2026-10-08b; webhook=${displayUrl || '(empty)'}; mode=${mode}; rootsOnly=${String(config.rootsOnly)}; summaryChars=${String(summaryChars)}; subagents[${probeAccessors('subagents')}]`)

  if (!config.enabled) {
    ctx.logger.info('%c 已禁用', name)
    return
  }
  if (webhook === '') {
    ctx.logger.warn('%c 已加载，但 webhookUrl 为空：本轮不会发送任何通知。请在 profile 的 cordis.patch.yml 里填写 webhookUrl。', name)
  } else {
    ctx.logger.info('%c 已启用（mode=%s），目标 %c', name, mode, displayUrl)
  }

  /**
   * sessionId -> { timer, turn, detail }. One completed turn reaches both
   * `agent/turn-stopping` and the durable `turn/end` event; the second arrival
   * merges its richer reason into the same entry instead of sending twice.
   */
  const pending = new Map()
  /** sessionId -> turn number already scheduled, used to drop late duplicates. */
  const seenTurn = new Map()
  /** sessionId -> live Agent, captured on the way in because `turn/end` carries no agent. */
  const liveAgents = new Map()
  /** serialized delivery queue: one item per notification. */
  const queue = []
  let draining = false
  let lastSentAt = 0
  let disposed = false

  /** Build the current root-agent set, or undefined when the registry is unavailable. */
  function rootAgents() {
    try {
      const agents = ctx.agents
      if (agents === undefined || agents === null || typeof agents.roots !== 'function') return undefined
      const roots = agents.roots()
      return new Set(Array.isArray(roots) ? roots.map((agent) => agent?.id) : [])
    } catch {
      return undefined
    }
  }

  /** Decide whether this session's turn should produce a notification. */
  function shouldNotify(sessionId) {
    if (config.rootsOnly !== true) return true
    const roots = rootAgents()
    if (roots === undefined) return true
    return roots.has(sessionId)
  }

  /** Look up the live parent Agent for a session, preferring what the events gave us. */
  function findAgent(sessionId) {
    const cached = liveAgents.get(sessionId)
    if (cached !== undefined) return cached
    try {
      const agent = ctx.agents?.get?.(sessionId)
      if (agent !== undefined) liveAgents.set(sessionId, agent)
      return agent
    } catch {
      return undefined
    }
  }

  /**
   * Ask a one-shot subagent to compress this turn into a short digest.
   * @param {object} input - summarization input.
   * @param {string} input.sessionId - session whose turn is being summarized.
   * @param {string} [input.title] - session title.
   * @param {object} input.stats - output of `readTurnStats`.
   * @returns {Promise<{ summary?: string, note?: string, error?: string }>} the digest, or why it is absent.
   */
  async function summarize({ sessionId, title, stats }) {
    // LOCAL PATCH (2026-10-08): was `const subagents = ctx.subagents`, which throws in a
    // real Cordis loader because this plugin declared no `inject` — the throw escaped
    // through an unhandled rejection and killed the DSH host on every sent notification.
    const subagents = readService('subagents')
    if (subagents === undefined || subagents === null || typeof subagents.start !== 'function') {
      return { error: 'subagent service unavailable' }
    }
    const parent = findAgent(sessionId)
    if (parent === undefined) {
      return { error: 'parent agent no longer live' }
    }
    let providers = []
    let provider
    let providerName
    try {
      providers = typeof subagents.list === 'function' ? subagents.list() : []
      if (!Array.isArray(providers)) providers = []
      providerName = providers.includes(config.summaryProvider) ? config.summaryProvider : providers[0]
      if (providerName === undefined) {
        return { error: 'no subagent provider registered' }
      }
      provider = typeof subagents.getProvider === 'function' ? subagents.getProvider(providerName) : undefined
    } catch {
      return { error: 'subagent provider lookup failed' }
    }
    const supports = provider?.capabilities ?? { agentOptions: true, toolFilter: true, persona: true, depthLimit: true }

    const chars = summaryChars === 'model' ? undefined : summaryChars
    const prompt = composeSummaryPrompt({
      userText: stats?.userText ?? '',
      assistantText: stats?.assistantText ?? '',
      title,
      maxChars: chars ?? 140,
    })

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), config.summaryTimeoutMs)
    timer.unref?.()
    let run
    try {
      run = await subagents.start(providerName, {
        label: 'wecom-summary',
        prompt: [{ type: 'text', text: prompt }],
        parent,
        signal: controller.signal,
        // This child only writes prose, so it must not be able to touch anything.
        ...(supports.toolFilter !== false ? { toolFilter: { allow: [] } } : {}),
        ...(supports.depthLimit !== false ? { maxDepth: 1 } : {}),
        ...(supports.persona !== false ? { persona: '你是会议纪要员，只做压缩，不提问、不建议、不寒暄。' } : {}),
        ...(config.summaryModel !== '' && supports.agentOptions !== false
          ? { agentOptions: { model: config.summaryModel } }
          : {}),
      })
      const result = await run.result
      const text = blocksToText(result?.output).replace(/\s+/g, ' ').trim()
      if (result?.stopReason !== 'completed' || text === '') {
        return { error: `summarizer ${String(result?.stopReason ?? 'failed')}` }
      }
      // A smaller model can still overshoot; the cap is ours to enforce.
      const bounded = chars === undefined ? text : truncateChars(text, chars)
      return {
        summary: bounded,
      }
    } catch (error) {
      return { error: error instanceof Error ? error.message : String(error) }
    } finally {
      clearTimeout(timer)
      // The run is a published child; release it whether or not it produced a digest.
      void Promise.resolve(run?.dispose?.()).catch(() => { })
    }
  }

  function enqueue(item) {
    // smart mode needs the live parent Agent, which is gone once the turn closes,
    // so the digest is computed here - outside the send queue, concurrently - and
    // only the finished text is handed to the serialized sender.
    if (profile.summarize && config.includeText !== false && webhook !== '' && item.summary === undefined) {
      void summarize({ sessionId: item.sessionId, title: item.title, stats: item.stats })
        .then((attempt) => {
          if (attempt.summary !== undefined) {
            item.summary = attempt.summary
            item.summaryNote = attempt.note ?? ''
            trace(`summary ok session=${item.sessionId} turn=${String(item.detail?.turn)} chars=${String([...attempt.summary].length)}`)
          } else {
            item.summaryNote = `智能总结不可用（${attempt.error ?? 'unknown'}），已退回截断`
            trace(`summary failed session=${item.sessionId} turn=${String(item.detail?.turn)}: ${attempt.error ?? 'unknown'}`)
          }
        })
        .catch((error) => {
          // LOCAL PATCH (2026-10-08): belt and braces. DSH turns an unhandled rejection
          // into a fatal host exit, so nothing may escape the summarizer path.
          item.summaryNote = `智能总结不可用（${error instanceof Error ? error.message : String(error)}），已退回截断`
          trace(`summary failed session=${item.sessionId} turn=${String(item.detail?.turn)}: ${item.summaryNote}`)
        })
        .finally(() => {
          queue.push(item)
          void drain()
        })
      return
    }
    queue.push(item)
    void drain()
  }

  async function drain() {
    if (draining || disposed) return
    draining = true
    try {
      while (queue.length > 0) {
        if (disposed) return
        const wait = config.minIntervalMs - (Date.now() - lastSentAt)
        if (wait > 0) {
          await new Promise((resolve) => setTimeout(resolve, wait))
          if (disposed) return
          continue
        }
        const item = queue.shift()
        lastSentAt = Date.now()
        try {
          await deliver(item)
        } catch (error) {
          // LOCAL PATCH (2026-10-08): a delivery throw must not become an unhandled
          // rejection, which DSH would escalate to a fatal host exit.
          trace(`deliver threw turn=${String(item?.detail?.turn)}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    } finally {
      draining = false
    }
  }

  /** Compose and send one queued notification. Never throws. */
  async function deliver({ sessionId, title, detail, text, stats, summary, summaryNote = '' }) {
    const content = composeMarkdown({
      mode,
      sessionId,
      title,
      turn: detail?.turn,
      reason: detail?.reason,
      time: detail?.time,
      text,
      summary,
      summaryNote: profile.summarize && config.includeText !== false && webhook !== '' ? summaryNote : '',
      stats,
      heading: config.heading,
      mentions: config.mentionList,
      excerptBytes,
      maxTotalBytes: WEBHOOK_MAX_BYTES,
    })

    if (webhook === '') {
      ctx.logger.info('%c [dry-run] 未配置 webhookUrl，本应发送：\n%c', name, content)
      trace(`dry-run mode=${mode} turn=${String(detail?.turn)}\n${content}`)
      return
    }
    const result = await sendWeComMessage({
      webhookUrl: webhook,
      content,
      mentionedMobileList: config.mentionList,
      timeoutMs: config.timeoutMs,
      attempts: config.attempts,
      log: (message) => ctx.logger.debug('%c %s', name, message),
    })
    if (result.ok) {
      trace(`sent mode=${mode} turn=${String(detail?.turn)} ok`)
      ctx.logger.debug('%c 已通知会话 %s 第 %s 轮', name, sessionId, String(detail?.turn ?? '?'))
    } else {
      trace(`sent mode=${mode} turn=${String(detail?.turn)} failed: ${result.error ?? 'unknown failure'}`)
      ctx.logger.warn('%c 发送失败（%s）：%s', name, displayUrl, result.error ?? 'unknown failure')
    }
  }

  /** Merge-and-schedule one finished turn. */
  function schedule(sessionId, session, detail) {
    if (disposed) return
    if (!shouldNotify(sessionId)) return

    const entry = pending.get(sessionId)
    const turn = detail?.turn
    if (typeof turn === 'number') {
      if (entry !== undefined && entry.turn !== turn) return
      if (entry === undefined && seenTurn.get(sessionId) === turn) return
    }

    const needsText = profile.excerptBytes > 0 || profile.summarize
    const needsStats = profile.stats || profile.summarize
    let title = ''
    let text = ''
    let stats
    try {
      title = readSessionTitle(ctx, session)
    } catch {
      title = ''
    }
    if (needsText && config.includeText !== false) {
      try {
        text = readLastAssistantText(session)
      } catch {
        text = ''
      }
    }
    if (needsStats) {
      try {
        stats = readTurnStats(session, typeof turn === 'number' ? turn : undefined)
      } catch {
        stats = undefined
      }
    }

    const merged = { ...(entry?.detail ?? {}), ...(detail ?? {}) }
    if (entry !== undefined) clearTimeout(entry.timer)
    const timer = setTimeout(() => {
      pending.delete(sessionId)
      if (typeof turn === 'number') seenTurn.set(sessionId, turn)
      enqueue({ sessionId, title, detail: merged, text, stats })
    }, config.debounceMs)
    timer.unref?.()
    pending.set(sessionId, { timer, turn, detail: merged })
  }

  const onTurnStopping = (payload) => {
    const agent = payload?.agent
    if (agent === undefined) return
    liveAgents.set(agent.id, agent)
    trace(`agent/turn-stopping session=${agent.id} turn=${String(payload.turn)}`)
    schedule(agent.id, agent.session, { turn: payload.turn, reason: { kind: 'completed' }, time: Date.now() })
  }

  const onSessionEvent = (session, event) => {
    if (event?.type !== 'turn/end') return
    trace(`turn/end session=${session?.id} turn=${String(event.data?.turn)} reason=${String(event.data?.reason?.kind)}`)
    schedule(session.id, session, { turn: event.data?.turn, reason: event.data?.reason, time: event.time })
  }

  ctx.on('agent/turn-stopping', onTurnStopping)
  ctx.on('session/event', onSessionEvent)
  ctx.on('agent/disposed', (payload) => {
    const id = payload?.agent?.id
    if (typeof id !== 'string') return
    const entry = pending.get(id)
    if (entry !== undefined) clearTimeout(entry.timer)
    pending.delete(id)
    seenTurn.delete(id)
    liveAgents.delete(id)
  })

  ctx.effect(() => () => {
    disposed = true
    for (const entry of pending.values()) clearTimeout(entry.timer)
    pending.clear()
    seenTurn.clear()
    liveAgents.clear()
    queue.length = 0
  }, 'wecom-turn-notify.dispose()')
}
