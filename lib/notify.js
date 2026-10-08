/**
 * Pure helpers for the WeCom turn-notification plugin: webhook redaction, byte-safe
 * truncation, session-log reading and message composition.
 * Nothing here touches plugin state, so every function is unit-testable on its own.
 * @module dsh-plugin-wecom-turn-notify/notify
 */

/** WeCom group-robot payload cap is 4096 bytes; stay clearly below it. */
export const WEBHOOK_MAX_BYTES = 3800;

/**
 * Replace the webhook `key` query parameter so a URL can be logged or shown in an error.
 * @param {string} url - raw webhook URL.
 * @returns {string} the URL with its key removed, or the input when it cannot be parsed.
 */
export function redactWebhook(url) {
  if (typeof url !== 'string' || url === '') return '';
  const index = url.indexOf('key=');
  if (index === -1) return url;
  const end = url.indexOf('&', index);
  return `${url.slice(0, index)}key=***${end === -1 ? '' : url.slice(end)}`;
}

/**
 * Validate a webhook address without ever echoing its key.
 * @param {string} url - candidate webhook URL.
 * @returns {{ ok: true, url: URL } | { ok: false, reason: string }} the parsed URL or why it was refused.
 */
export function checkWebhook(url) {
  if (typeof url !== 'string' || url.trim() === '') {
    return { ok: false, reason: 'the webhook URL is empty' };
  }
  let parsed;
  try {
    parsed = new URL(url.trim());
  } catch {
    return { ok: false, reason: 'the webhook URL is not a valid absolute URL' };
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    return { ok: false, reason: `unsupported webhook protocol "${parsed.protocol}"` };
  }
  if (!parsed.searchParams.get('key')) {
    return { ok: false, reason: 'the webhook URL has no "key" query parameter' };
  }
  return { ok: true, url: parsed };
}

/**
 * Truncate text to a byte budget without splitting a Unicode code point.
 * @param {string} text - input text.
 * @param {number} maxBytes - non-negative byte budget.
 * @returns {string} the original text, or a prefix plus an ellipsis.
 */
export function truncateBytes(text, maxBytes) {
  const value = String(text ?? '');
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return value;
  const ellipsis = '…';
  const budget = Math.max(0, maxBytes - Buffer.byteLength(ellipsis, 'utf8'));
  let out = '';
  let used = 0;
  for (const char of value) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > budget) break;
    out += char;
    used += size;
  }
  return out + ellipsis;
}

/**
 * Flatten one message's content blocks into plain text.
 * @param {unknown} content - the `content` array of a session message.
 * @returns {string} concatenated text blocks, trimmed.
 */
export function contentToText(content) {
  if (!Array.isArray(content)) return '';
  const parts = [];
  for (const block of content) {
    if (block !== null && typeof block === 'object' && block.type === 'text' && typeof block.text === 'string') {
      parts.push(block.text);
    } else if (typeof block === 'string') {
      parts.push(block);
    }
  }
  return parts.join('\n').trim();
}

/**
 * Read the latest assistant text of a session, stopping at the turn boundary.
 * @param {unknown} session - live session (only `log` is touched).
 * @returns {string} the newest assistant text, or '' when the session exposes none.
 */
export function readLastAssistantText(session) {
  const log = session?.log;
  if (!Array.isArray(log)) return '';
  for (let index = log.length - 1; index >= 0; index -= 1) {
    const event = log[index];
    if (event?.type === 'turn/end' && index < log.length - 1) break;
    if (event?.type === 'assistant/message') {
      const text = contentToText(event.data?.message?.content);
      if (text !== '') return text;
    }
  }
  return '';
}

/**
 * Read the durable session title through the title service, falling back to the log.
 * @param {unknown} ctx - plugin context, may carry a `sessionTitle` service.
 * @param {unknown} session - live session.
 * @returns {string} the title, or '' when none was accepted yet.
 */
export function readSessionTitle(ctx, session) {
  try {
    const snapshot = ctx?.sessionTitle?.get?.(session);
    if (typeof snapshot === 'string' && snapshot !== '') return snapshot;
    if (typeof snapshot?.title === 'string' && snapshot.title !== '') return snapshot.title;
  } catch {
    // fall through to the log fold
  }
  try {
    const log = session?.log;
    if (Array.isArray(log)) {
      for (let index = log.length - 1; index >= 0; index -= 1) {
        const event = log[index];
        if (event?.type === 'session/title' && typeof event.data?.title === 'string' && event.data.title !== '') {
          return event.data.title;
        }
      }
    }
  } catch {
    // no title available
  }
  return '';
}

/** Map a durable `turn/end` reason kind to a short human label. */
function reasonLabel(reason) {
  const kind = reason?.kind;
  switch (kind) {
    case 'completed': return '已完成';
    case 'aborted':
      return typeof reason?.reason === 'string' && reason.reason !== '' ? `已中止（${reason.reason}）` : '已中止';
    case 'error': {
      const message = reason?.error?.message ?? reason?.error?.code;
      return typeof message === 'string' && message !== '' ? `出错：${truncateBytes(message, 160)}` : '出错';
    }
    case 'max-tokens': return '达到输出上限';
    case 'interrupted': return '被中断';
    default: return typeof kind === 'string' && kind !== '' ? kind : '未知';
  }
}

/** Format a timestamp the way a person reads it in a chat notification. */
function formatTime(time) {
  const date = new Date(typeof time === 'number' ? time : Date.now());
  const pad = (value) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} `
    + `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/**
 * Compose the WeCom `markdown` message body for one finished turn.
 * @param {object} input - one turn's notification input.
 * @param {string} input.sessionId - session identity.
 * @param {string} [input.title] - durable session title.
 * @param {number} [input.turn] - turn number.
 * @param {unknown} [input.reason] - the `turn/end` reason.
 * @param {number} [input.time] - event time in milliseconds.
 * @param {string} [input.text] - the latest assistant text.
 * @param {string} [input.heading] - heading line, defaulting to the plugin's own.
 * @param {readonly string[]} [input.mentions] - `mentioned_mobile_list` entries.
 * @param {number} [input.maxContentBytes] - byte budget for the assistant excerpt.
 * @param {number} [input.maxTotalBytes] - byte budget for the whole body.
 * @returns {string} the markdown body sent to WeCom.
 */
export function composeMarkdown(input) {
  const {
    sessionId = '',
    title = '',
    turn,
    reason,
    time,
    text = '',
    heading = 'DSH 对话完成',
    mentions = [],
    maxContentBytes = 1200,
    maxTotalBytes = WEBHOOK_MAX_BYTES,
  } = input ?? {};

  const lines = [`## ${heading}`];
  if (title !== '') lines.push(`> **会话**：${title}`);
  if (sessionId !== '') lines.push(`> **会话 ID**：${sessionId}`);
  const facts = [];
  if (typeof turn === 'number') facts.push(`第 ${turn} 轮`);
  facts.push(reasonLabel(reason));
  facts.push(formatTime(time));
  lines.push(`> **状态**：${facts.join(' · ')}`);

  const excerpt = truncateBytes(text.trim(), maxContentBytes);
  lines.push('');
  lines.push(excerpt === '' ? '_本轮没有文本回复。_' : excerpt);

  const mentioned = mentions.filter((item) => typeof item === 'string' && item !== '');
  if (mentioned.length > 0) {
    lines.push('');
    lines.push(mentioned.map((item) => (item === '@all' ? '@all' : `<@${item}>`)).join(' '));
  }

  return truncateBytes(lines.join('\n'), maxTotalBytes);
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
  } = options ?? {};

  const checked = checkWebhook(webhookUrl);
  if (!checked.ok) return { ok: false, error: checked.reason };

  const body = {
    msgtype: 'markdown',
    markdown: {
      content,
      ...(mentionedMobileList.length > 0 ? { mentioned_mobile_list: [...mentionedMobileList] } : {}),
    },
  };

  let lastError;
  for (let attempt = 1; attempt <= Math.max(1, attempts); attempt += 1) {
    try {
      const response = await fetchImpl(checked.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      const raw = await response.text();
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch {
        payload = undefined;
      }
      if (!response.ok) {
        lastError = `HTTP ${response.status}: ${truncateBytes(raw, 200)}`;
      } else if (payload === undefined) {
        lastError = `unparsable response: ${truncateBytes(raw, 200)}`;
      } else if (payload.errcode === 0) {
        return { ok: true, code: 0 };
      } else {
        const detail = `${payload.errcode}: ${payload.errmsg ?? ''}`;
        // An invalid key or a refused payload never succeeds on retry.
        if (payload.errcode === 93000 || payload.errcode === 40001 || payload.errcode === 40008) {
          return { ok: false, code: payload.errcode, message: payload.errmsg, error: detail };
        }
        lastError = detail;
      }
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts) {
      log(`delivery attempt ${attempt} failed (${lastError}); retrying`, undefined);
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs * attempt));
    }
  }
  return { ok: false, error: lastError ?? 'unknown failure' };
}
