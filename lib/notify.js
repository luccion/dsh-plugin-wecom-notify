/**
 * Pure helpers for the WeCom turn-notification plugin: webhook redaction, byte-safe
 * truncation, session-log reading, turn statistics and message composition for all
 * four notification modes.
 * Nothing here touches plugin state, so every function is unit-testable on its own.
 * @module dsh-plugin-wecom-turn-notify/notify
 */

/** WeCom group-robot payload cap is 4096 bytes; stay clearly below it. */
export const WEBHOOK_MAX_BYTES = 3800

/** Notification detail levels, from the tersest to the richest. */
export const MODES = ['status', 'normal', 'detailed', 'smart']

/** Per-mode defaults, overridable from the plugin config. */
export const MODE_DEFAULTS = {
  status: { excerptBytes: 0, stats: false, summarize: false },
  normal: { excerptBytes: 1200, stats: false, summarize: false },
  detailed: { excerptBytes: 3500, stats: true, summarize: false },
  smart: { excerptBytes: 0, stats: true, summarize: true },
}

/** One-line description of each mode, shared by the config schema and the README. */
export const MODE_LABELS = {
  status: '仅状态汇报：只发标题与「第几轮 / 结果 / 时间」，不带正文。',
  normal: '普通：状态行 + 本轮助手文本摘要（默认）。',
  detailed: '详细：更长的摘要，并附本轮工具调用统计与错误数。',
  smart: '智能总结：调用子智能体把本轮内容压缩成限字简报（失败时自动退回截断）。',
}

/**
 * Replace the webhook `key` query parameter so a URL can be logged or shown in an error.
 * @param {string} url - raw webhook URL.
 * @returns {string} the URL with its key removed, or the input when it cannot be parsed.
 */
export function redactWebhook(url) {
  if (typeof url !== 'string' || url === '') return ''
  const index = url.indexOf('key=')
  if (index === -1) return url
  const end = url.indexOf('&', index)
  return `${url.slice(0, index)}key=***${end === -1 ? '' : url.slice(end)}`
}

/**
 * Validate a webhook address without ever echoing its key.
 * @param {string} url - candidate webhook URL.
 * @returns {{ ok: true, url: URL } | { ok: false, reason: string }} the parsed URL or why it was refused.
 */
export function checkWebhook(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    return { ok: false, reason: 'the webhook URL is empty' }
  }
  let parsed
  try {
    parsed = new URL(url.trim())
  } catch {
    return { ok: false, reason: 'the webhook URL is not a valid absolute URL' }
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: `unsupported webhook protocol "${parsed.protocol}"` }
  }
  if (!parsed.searchParams.get('key')) {
    return { ok: false, reason: 'the webhook URL has no "key" query parameter' }
  }
  return { ok: true, url: parsed }
}

/**
 * Truncate text to a byte budget without splitting a Unicode code point.
 * @param {string} text - input text.
 * @param {number} maxBytes - non-negative byte budget.
 * @returns {string} the original text, or a prefix plus an ellipsis.
 */
export function truncateBytes(text, maxBytes) {
  const value = String(text ?? '')
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value
  const ellipsis = '…'
  const budget = Math.max(0, maxBytes - Buffer.byteLength(ellipsis, 'utf8'))
  let out = ''
  let used = 0
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8')
    if (used + size > budget) break
    out += char
    used += size
  }
  return out + ellipsis
}

/**
 * Truncate text to a character budget without splitting a surrogate pair.
 * @param {string} text - input text.
 * @param {number} maxChars - non-negative character budget.
 * @returns {string} the original text, or a prefix plus an ellipsis.
 */
export function truncateChars(text, maxChars) {
  const chars = [...String(text ?? '')]
  if (chars.length <= maxChars) return chars.join('')
  if (maxChars <= 0) return '…'
  return chars.slice(0, maxChars).join('') + '…'
}

/**
 * Flatten one message's content blocks into plain text.
 * @param {unknown} content - the `content` array of a session message.
 * @returns {string} concatenated text blocks, trimmed.
 */
export function contentToText(content) {
  if (!Array.isArray(content)) return ''
  const parts = []
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text)
    } else if (typeof block === 'string') {
      parts.push(block)
    }
  }
  return parts.join('\n').trim()
}

/**
 * Read the latest assistant text of a session, stopping at the turn boundary.
 * @param {unknown} session - live session (only `log` is touched).
 * @returns {string} the newest assistant text, or '' when the session exposes none.
 */
export function readLastAssistantText(session) {
  const events = session?.log
  if (!Array.isArray(events)) return ''
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event?.type === 'turn/end' && index < events.length - 1) break
    if (event?.type === 'assistant/message') {
      const text = contentToText(event.data?.message?.content)
      if (text !== '') return text
    }
  }
  return ''
}

/**
 * Collect this turn's statistics from a session log.
 * @param {unknown} session - live session (only `log` is touched).
 * @param {number} [turn] - turn number to measure; defaults to the last one.
 * @returns {{ turn: number | undefined, steps: number, toolCalls: number, toolErrors: number, userText: string, assistantText: string }} the tally.
 */
export function readTurnStats(session, turn) {
  const empty = { turn: undefined, steps: 0, toolCalls: 0, toolErrors: 0, userText: '', assistantText: '' }
  const events = session?.log
  if (!Array.isArray(events)) return empty

  // Find the last turn/start (or the requested turn) and walk forward from there.
  let start = 0
  let seen = -1
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type !== 'turn/start') continue
    if (turn === undefined || event.data?.turn === turn) {
      start = index
      seen = event.data?.turn
    }
  }
  if (seen === -1) return empty

  const stats = { ...empty, turn: seen }
  const userParts = []
  const assistantParts = []
  for (let index = start; index < events.length; index += 1) {
    const event = events[index]
    if (event?.type === 'turn/end' || (event?.type === 'turn/start' && index > start)) break
    switch (event.type) {
      case 'step/start':
        stats.steps += 1
        break
      case 'tool/call':
        stats.toolCalls += 1
        break
      case 'tool/result':
        if (event.data?.error !== undefined || event.data?.message?.isError === true) stats.toolErrors += 1
        break
      case 'user/message': {
        const text = contentToText(event.data?.content)
        if (text !== '') userParts.push(text)
        break
      }
      case 'assistant/message': {
        const text = contentToText(event.data?.message?.content)
        if (text !== '') assistantParts.push(text)
        break
      }
      default:
        break
    }
  }
  stats.userText = userParts.join('\n').trim()
  stats.assistantText = assistantParts.join('\n').trim()
  return stats
}

/**
 * Read the durable session title through the title service, falling back to the log.
 * @param {unknown} ctx - plugin context, may carry a `sessionTitle` service.
 * @param {unknown} session - live session.
 * @returns {string} the title, or '' when none was accepted yet.
 */
export function readSessionTitle(ctx, session) {
  try {
    const snapshot = ctx?.sessionTitle?.get?.(session)
    if (typeof snapshot === 'string' && snapshot !== '') return snapshot
    if (typeof snapshot?.title === 'string' && snapshot.title !== '') return snapshot.title
  } catch {
    // fall through to the log fold
  }
  try {
    const log = session?.log
    if (Array.isArray(log)) {
      for (let index = log.length - 1; index >= 0; index -= 1) {
        const event = log[index]
        if (event?.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title !== '') {
          return event.data.title
        }
      }
    }
  } catch {
    // no title available
  }
  return ''
}

/** Map a durable `turn/end` reason kind to a short human label. */
export function reasonLabel(reason) {
  const kind = reason?.kind
  switch (kind) {
    case 'completed': return '已完成'
    case 'aborted':
      return typeof reason?.reason === 'string' && reason.reason !== '' ? `已中止（${reason.reason}）` : '已中止'
    case 'error': {
      const message = reason?.error?.message ?? reason?.error?.code
      return typeof message === 'string' && message !== '' ? `出错：${truncateBytes(message, 160)}` : '出错'
    }
    case 'max-tokens': return '达到输出上限'
    case 'interrupted': return '被中断'
    case 'blocked': return '被阻塞'
    case 'forked': return '已分叉'
    default: return typeof kind === 'string' && kind !== '' ? kind : '未知'
  }
}

/** Whether a reason names a failed turn. */
function reasonFailed(reason) {
  const kind = reason?.kind
  return kind === 'error' || kind === 'aborted' || kind === 'interrupted' || kind === 'blocked' || kind === 'max-tokens'
}

/** Format a timestamp the way a person reads it in a chat notification. */
export function formatTime(time) {
  const date = new Date(typeof time === 'number' ? time : Date.now())
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Pick the emoji that heads the message for one turn outcome. */
function headingMark(reason) {
  const kind = reason?.kind
  if (kind === 'completed') return '✅'
  if (kind === 'max-tokens') return '⚠️'
  return '❌'
}

/**
 * Compose the WeCom `markdown` message body for one finished turn.
 *
 * Extraction precedence follows the mode: `smart` prefers the supplied summary,
 * otherwise the raw excerpt is truncated to the mode's budget.
 *
 * @param {object} input - one turn's notification input.
 * @param {string} [input.mode] - one of {@link MODES}; defaults to `normal`.
 * @param {string} input.sessionId - session identity.
 * @param {string} [input.title] - durable session title.
 * @param {number} [input.turn] - turn number.
 * @param {unknown} [input.reason] - the `turn/end` reason.
 * @param {number} [input.time] - event time in milliseconds.
 * @param {string} [input.text] - the latest assistant text.
 * @param {string} [input.summary] - a ready-made summary (smart mode).
 * @param {string} [input.summaryNote] - a short note about how the summary was produced.
 * @param {object} [input.stats] - output of {@link readTurnStats}.
 * @param {string} [input.heading] - heading line, defaulting to the plugin's own.
 * @param {readonly string[]} [input.mentions] - `mentioned_mobile_list` entries.
 * @param {number} [input.excerptBytes] - explicit byte budget, overriding the mode.
 * @param {number} [input.maxTotalBytes] - byte budget for the whole body.
 * @returns {string} the markdown body sent to WeCom.
 */
export function composeMarkdown(input) {
  const {
    mode = 'normal',
    sessionId = '',
    title = '',
    turn,
    reason,
    time,
    text = '',
    summary,
    summaryNote = '',
    stats,
    heading = 'DSH 对话完成',
    mentions = [],
    excerptBytes,
    maxTotalBytes = WEBHOOK_MAX_BYTES,
  } = input ?? {}

  const profile = MODE_DEFAULTS[mode] ?? MODE_DEFAULTS.normal
  const budget = typeof excerptBytes === 'number' ? excerptBytes : profile.excerptBytes
  const lines = [`## ${headingMark(reason)} ${heading}`]
  if (title !== '') lines.push(`> **会话**：${title}`)
  if (sessionId !== '') lines.push(`> **会话 ID**：${sessionId}`)

  const facts = []
  if (typeof turn === 'number') facts.push(`第 ${turn} 轮`)
  facts.push(reasonLabel(reason))
  facts.push(formatTime(time))
  lines.push(`> **状态**：${facts.join(' · ')}`)

  if (profile.stats && stats !== undefined && stats !== null) {
    const detail = []
    if (typeof stats.steps === 'number' && stats.steps > 0) detail.push(`${stats.steps} 步`)
    if (typeof stats.toolCalls === 'number' && stats.toolCalls > 0) {
      detail.push(stats.toolErrors > 0 ? `${stats.toolCalls} 次工具调用（${stats.toolErrors} 次失败）` : `${stats.toolCalls} 次工具调用`)
    }
    if (detail.length > 0) lines.push(`> **过程**：${detail.join(' · ')}`)
    if (reasonFailed(reason)) lines.push('> **下一步建议**：查看会话记录确认失败原因。')
  }

  if (mode === 'smart') {
    const hasSummary = typeof summary === 'string' && summary.trim() !== ''
    const body = hasSummary
      ? summary.trim()
      : truncateBytes(text.trim(), budget > 0 ? budget : 800)
    lines.push('')
    lines.push(body === '' ? '_本轮没有文本回复。_' : body)
    if (summaryNote !== '') lines.push(`>\n> _${summaryNote}_`)
  } else if (budget > 0) {
    const excerpt = truncateBytes(text.trim(), budget)
    lines.push('')
    lines.push(excerpt === '' ? '_本轮没有文本回复。_' : excerpt)
  } else {
    // status mode: no body at all.
    lines.push('')
  }

  const mentioned = mentions.filter((item) => typeof item === 'string' && item !== '')
  if (mentioned.length > 0) {
    lines.push('')
    lines.push(mentioned.map((item) => (item === '@all' ? '@all' : `<@${item}>`)).join(' '))
  }

  return truncateBytes(lines.join('\n').trimEnd(), maxTotalBytes)
}

/**
 * POST one markdown message to a WeCom group robot.
 * @param {object} options - delivery options.
 * @param {string} options.webhookUrl - full webhook URL including its key.
 * @param {string} options.content - markdown body.
 * @param {readonly string[]} [options.mentionedMobileList] - WeCom mention list.
 * @param {number} [options.timeoutMs] - per-attempt timeout.
 * @param {number} [options.attempts] - total attempts, including the first.
 * @param {number} [options.retryDelayMs] - base delay between attempts.
 * @param {(message: string, error?: unknown) => void} [options.log] - diagnostic sink, never prints the key.
 * @param {typeof fetch} [options.fetchImpl] - injected fetch, for tests.
 * @returns {Promise<{ ok: boolean, code?: number, message?: string, error?: string }>} the delivery outcome.
 */
export async function sendWeComMessage(options) {
  const {
    webhookUrl,
    content,
    mentionedMobileList = [],
    timeoutMs = 8000,
    attempts = 3,
    retryDelayMs = 1000,
    log = () => {},
    fetchImpl = globalThis.fetch,
  } = options ?? {}

  const checked = checkWebhook(webhookUrl)
  if (!checked.ok) return { ok: false, error: checked.reason }

  const body = {
    msgtype: 'markdown',
    markdown: {
      content,
      ...(mentionedMobileList.length > 0 ? { mentioned_mobile_list: [...mentionedMobileList] } : {}),
    },
  }

  let lastError
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    try {
      const response = await fetchImpl(checked.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      })
      const raw = await response.text()
      let payload
      try {
        payload = JSON.parse(raw)
      } catch {
        payload = undefined
      }
      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${truncateBytes(raw, 200)}`
      } else if (payload === undefined) {
        lastError = `unparsable response: ${truncateBytes(raw, 200)}`
      } else if (payload.errcode === 0) {
        return { ok: true, code: 0 }
      } else {
        const detail = `${payload.errcode}: ${payload.errmsg ?? ''}`
        // An invalid key or a refused payload never succeeds on retry.
        if (payload.errcode === 93000 || payload.errcode === 40001 || payload.errcode === 40008) {
          return { ok: false, code: payload.errcode, message: payload.errmsg, error: detail }
        }
        lastError = detail
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error)
    }
    if (attempt < attempts) {
      log(`delivery attempt ${attempt} failed (${lastError}); retrying`, undefined)
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt))
    }
  }
  return { ok: false, error: lastError ?? 'unknown failure' }
}

/**
 * Compose the prompt handed to the summarizer subagent.
 * @param {object} input - summarization input.
 * @param {string} [input.userText] - what the person asked for this turn.
 * @param {string} [input.assistantText] - what the agent answered.
 * @param {number} [input.maxChars] - hard character cap for the answer.
 * @param {number} [input.maxInputBytes] - byte budget for the supplied material.
 * @param {string} [input.title] - session title, for context.
 * @returns {string} the prompt text.
 */
export function composeSummaryPrompt(input) {
  const {
    userText = '',
    assistantText = '',
    maxChars = 140,
    maxInputBytes = 6000,
    title = '',
  } = input ?? {}

  const material = [
    title !== '' ? `【会话标题】${title}` : '',
    userText !== '' ? `【用户这一轮的诉求】\n${userText}` : '',
    assistantText !== '' ? `【助手这一轮的回复】\n${assistantText}` : '',
  ].filter((part) => part !== '').join('\n\n')

  return [
    `请把下面这一轮对话压缩成一条中文简报，硬性上限 ${maxChars} 个字符（汉字、字母、数字、标点各算 1 个），宁可更短也不要超。`,
    '',
    '要求：',
    `- 只输出简报正文，不要标题、不要 markdown 标记、不要引号、不要解释。`,
    `- 说清「做了什么、结论是什么」；有失败、风险或待确认事项必须写出来。`,
    `- 不要复述过程细节，不要出现「用户」「助手」这类称谓。`,
    `- 超过 ${maxChars} 字符会被截断，所以先保证重点在前面。`,
    '',
    '材料：',
    truncateBytes(material, maxInputBytes),
  ].join('\n')
}
