/**
 * WeCom (企业微信) turn-completion notifications.
 *
 * The plugin watches every finished conversation turn and posts a markdown
 * message to one WeCom group-robot webhook. It is deliberately non-blocking on
 * the agent path: events only schedule work, and delivery happens later on a
 * serialized queue so a slow or rate-limited webhook can never stall a turn.
 *
 * @module dsh-plugin-wecom-turn-notify
 */
import Schema from '@deepseek-ai/schemastery'
import { appendFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WEBHOOK_MAX_BYTES,
  composeMarkdown,
  readLastAssistantText,
  readSessionTitle,
  redactWebhook,
  sendWeComMessage,
} from './lib/notify.js'

/** Cordis plugin name. */
export const name = 'wecom-turn-notify'

/** Live configuration. */
export const Config = Schema.object({
  webhookUrl: Schema.string()
    .default('')
    .description('企业微信群机器人 Webhook 地址（https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...）。留空则只记录日志、不发送。'),
  enabled: Schema.boolean()
    .default(true)
    .description('是否启用通知。'),
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
    .description('是否附带本轮最后的助手文本摘要。'),
  maxContentBytes: Schema.natural()
    .role('ms')
    .default(1200)
    .description('摘要的最大字节数。'),
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
  if (path === '') return () => {}
  return (line) => {
    try {
      appendFileSync(path, `${new Date().toISOString()} ${line}\n`)
    } catch {
      // a trace failure must never affect the turn
    }
  }
}

/**
 * Install the notification listener.
 * @param {import('@deepseek-ai/cordis').Context} ctx - the owning plugin context.
 * @param {object} config - validated configuration.
 */
export function apply(ctx, config) {
  const webhook = typeof config.webhookUrl === 'string' ? config.webhookUrl.trim() : ''
  const displayUrl = redactWebhook(webhook)

  /**
   * Optional activation trace. The Electron build keeps the Host's stdout out of
   * reach, so a diagnostic log is the only way to confirm the plugin is live.
   */
  const trace = makeTrace(resolveTracePath(config))

  trace(`apply() entered; webhook=${displayUrl || '(empty)'}; rootsOnly=${String(config.rootsOnly)}`)

  if (!config.enabled) {
    ctx.logger.info('%c 已禁用', name)
    return
  }
  if (webhook === '') {
    ctx.logger.warn('%c 已加载，但 webhookUrl 为空：本轮不会发送任何通知。请在 profile 的 cordis.patch.yml 里填写 webhookUrl。', name)
  } else {
    ctx.logger.info('%c 已启用，目标 %c', name, displayUrl)
  }

  /**
   * sessionId -> { timer, turn, detail }. One completed turn reaches both
   * `agent/turn-stopping` and the durable `turn/end` event; the second arrival
   * merges its richer reason into the same entry instead of sending twice.
   */
  const pending = new Map()
  /** sessionId -> turn number already scheduled, used to drop late duplicates. */
  const seenTurn = new Map()
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

  function enqueue(item) {
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
        await deliver(item)
      }
    } finally {
      draining = false
    }
  }

  /** Compose and send one queued notification. Never throws. */
  async function deliver({ sessionId, title, detail, text }) {
    const content = composeMarkdown({
      sessionId,
      title,
      turn: detail?.turn,
      reason: detail?.reason,
      time: detail?.time,
      text,
      heading: config.heading,
      mentions: config.mentionList,
      maxContentBytes: config.maxContentBytes,
      maxTotalBytes: WEBHOOK_MAX_BYTES,
    })
    if (webhook === '') {
      ctx.logger.info('%c [dry-run] 未配置 webhookUrl，本应发送：\n%c', name, content)
      trace(`dry-run turn=${String(detail?.turn)}\n${content}`)
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
      trace(`sent turn=${String(detail?.turn)} ok`)
      ctx.logger.debug('%c 已通知会话 %s 第 %s 轮', name, sessionId, String(detail?.turn ?? '?'))
    } else {
      trace(`sent turn=${String(detail?.turn)} failed: ${result.error ?? 'unknown failure'}`)
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

    let title = ''
    let text = ''
    try {
      title = readSessionTitle(ctx, session)
    } catch {
      title = ''
    }
    if (config.includeText !== false) {
      try {
        text = readLastAssistantText(session)
      } catch {
        text = ''
      }
    }

    const merged = { ...(entry?.detail ?? {}), ...(detail ?? {}) }
    if (entry !== undefined) clearTimeout(entry.timer)
    const timer = setTimeout(() => {
      pending.delete(sessionId)
      if (typeof turn === 'number') seenTurn.set(sessionId, turn)
      enqueue({ sessionId, title, detail: merged, text })
    }, config.debounceMs)
    timer.unref?.()
    pending.set(sessionId, { timer, turn, detail: merged })
  }

  const onTurnStopping = (payload) => {
    const agent = payload?.agent
    if (agent === undefined) return
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
  })

  ctx.effect(() => () => {
    disposed = true
    for (const entry of pending.values()) clearTimeout(entry.timer)
    pending.clear()
    seenTurn.clear()
    queue.length = 0
  }, 'wecom-turn-notify.dispose()')
}
