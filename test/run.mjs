/**
 * Dependency-free checks for the WeCom turn-notification plugin.
 * Run: node test/run.mjs
 */
import assert from 'node:assert/strict'
import {
  MODE_DEFAULTS,
  MODE_LABELS,
  MODES,
  WEBHOOK_MAX_BYTES,
  checkWebhook,
  composeMarkdown,
  composeSummaryPrompt,
  contentToText,
  readLastAssistantText,
  readSessionTitle,
  readTurnStats,
  redactWebhook,
  sendWeComMessage,
  truncateBytes,
  truncateChars,
} from '../lib/notify.js'

let passed = 0
const failures = []

async function test(title, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${title}`)
  } catch (error) {
    failures.push({ title, error })
    console.log(`FAIL  ${title}\n      ${error?.message ?? error}`)
  }
}

const WEBHOOK = 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=abc-123&x=1'

await test('redactWebhook hides the key and keeps other parameters', () => {
  assert.equal(redactWebhook(WEBHOOK), 'https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=***&x=1')
  assert.equal(redactWebhook('https://example.com/hook'), 'https://example.com/hook')
  assert.equal(redactWebhook(''), '')
})

await test('checkWebhook accepts a real webhook and refuses incomplete ones', () => {
  assert.equal(checkWebhook(WEBHOOK).ok, true)
  assert.equal(checkWebhook('').ok, false)
  assert.equal(checkWebhook('not a url').ok, false)
  assert.equal(checkWebhook('https://qyapi.weixin.qq.com/cgi-bin/webhook/send').ok, false)
  assert.equal(checkWebhook('ftp://example.com/?key=1').ok, false)
})

await test('truncateBytes never splits a code point', () => {
  assert.equal(truncateBytes('abc', 10), 'abc')
  const cut = truncateBytes('你好世界', 10)
  assert.equal(cut, '你好…')
  assert.ok(Buffer.byteLength(cut, 'utf8') <= 10)
  assert.equal(truncateBytes('你好世界', 3), '…')
})

await test('truncateChars counts characters, not bytes', () => {
  assert.equal(truncateChars('abc', 5), 'abc')
  assert.equal(truncateChars('你好世界', 2), '你好…')
  assert.equal(truncateChars('🙂🙂🙂', 1), '🙂…')
  assert.equal(truncateChars('你好', 0), '…')
})

await test('contentToText keeps text blocks only', () => {
  assert.equal(contentToText([{ type: 'text', text: 'a' }, { type: 'tool-call', id: 'x' }, { type: 'text', text: 'b' }]), 'a\nb')
  assert.equal(contentToText(undefined), '')
})

await test('readLastAssistantText stops at the turn boundary', () => {
  const session = {
    log: [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'older' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
    ],
  }
  assert.equal(readLastAssistantText(session), 'older')
  assert.equal(readLastAssistantText({}), '')
})

await test('readTurnStats counts steps, tools and failures for one turn', () => {
  const session = {
    log: [
      { type: 'turn/start', data: { turn: 1 } },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'first' }] } },
      { type: 'step/start', data: { turn: 1, step: 1 } },
      { type: 'tool/call', data: { turn: 1, name: 'pwsh' } },
      { type: 'tool/result', data: { turn: 1, message: { content: [{ type: 'text', text: 'ok' }] } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done one' }] } } },
      { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
      { type: 'turn/start', data: { turn: 2 } },
      { type: 'user/message', data: { content: [{ type: 'text', text: 'second' }] } },
      { type: 'step/start', data: { turn: 2, step: 1 } },
      { type: 'tool/call', data: { turn: 2, name: 'read' } },
      { type: 'tool/result', data: { turn: 2, error: { name: 'X', code: 'ENOENT' }, message: { content: [] } } },
      { type: 'tool/call', data: { turn: 2, name: 'read' } },
      { type: 'tool/result', data: { turn: 2, message: { content: [] } } },
      { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'done two' }] } } },
    ],
  }
  const second = readTurnStats(session, 2)
  assert.deepEqual(
    { turn: second.turn, steps: second.steps, toolCalls: second.toolCalls, toolErrors: second.toolErrors },
    { turn: 2, steps: 1, toolCalls: 2, toolErrors: 1 },
  )
  assert.equal(second.userText, 'second')
  assert.equal(second.assistantText, 'done two')
  // Without an explicit turn it measures the last one.
  assert.equal(readTurnStats(session).turn, 2)
  assert.deepEqual(readTurnStats({}).toolCalls, 0)
})

await test('readSessionTitle prefers the title service, then the log', () => {
  const session = { log: [{ type: 'session/title', data: { title: 'from-log' } }] }
  assert.equal(readSessionTitle({ sessionTitle: { get: () => 'from-service' } }, session), 'from-service')
  assert.equal(readSessionTitle({}, session), 'from-log')
  assert.equal(readSessionTitle({}, { log: [] }), '')
})

await test('every mode is described and has defaults', () => {
  for (const mode of MODES) {
    assert.ok(MODE_DEFAULTS[mode], `missing defaults for ${mode}`)
    assert.equal(typeof MODE_LABELS[mode], 'string')
    assert.ok(MODE_LABELS[mode].length > 0)
  }
})

await test('composeMarkdown carries session facts and the excerpt', () => {
  const markdown = composeMarkdown({
    sessionId: 'session-1',
    title: '修复登录问题',
    turn: 3,
    reason: { kind: 'completed' },
    time: Date.UTC(2026, 0, 2, 3, 4, 5),
    text: '已经改好并跑过测试了。',
    heading: 'DSH 对话完成',
    mentions: ['13800000000'],
  })
  assert.ok(markdown.startsWith('## ✅ DSH 对话完成'))
  assert.ok(markdown.includes('**会话**：修复登录问题'))
  assert.ok(markdown.includes('**会话 ID**：session-1'))
  assert.ok(markdown.includes('第 3 轮'))
  assert.ok(markdown.includes('已完成'))
  assert.ok(markdown.includes('已经改好并跑过测试了。'))
  assert.ok(markdown.includes('<@13800000000>'))
})

await test('status mode sends the status line and nothing else', () => {
  const markdown = composeMarkdown({
    mode: 'status',
    sessionId: 's',
    turn: 4,
    reason: { kind: 'completed' },
    text: '这段正文不应该出现',
  })
  assert.ok(markdown.includes('第 4 轮'))
  assert.ok(!markdown.includes('这段正文不应该出现'))
  assert.ok(!markdown.includes('_本轮没有文本回复。_'))
  assert.ok(!markdown.includes('**过程**'))
})

await test('normal mode truncates to its own budget', () => {
  const long = 'x'.repeat(5000)
  const normal = composeMarkdown({ mode: 'normal', sessionId: 's', turn: 1, reason: { kind: 'completed' }, text: long })
  const detailed = composeMarkdown({ mode: 'detailed', sessionId: 's', turn: 1, reason: { kind: 'completed' }, text: long })
  assert.ok(normal.length < detailed.length)
  assert.ok(Buffer.byteLength(detailed, 'utf8') <= WEBHOOK_MAX_BYTES)
})

await test('detailed mode adds process stats and a failure hint', () => {
  const ok = composeMarkdown({
    mode: 'detailed',
    sessionId: 's',
    turn: 2,
    reason: { kind: 'completed' },
    text: 'fine',
    stats: { turn: 2, steps: 3, toolCalls: 5, toolErrors: 4, userText: '', assistantText: 'fine' },
  })
  assert.ok(ok.includes('**过程**：3 步 · 5 次工具调用（4 次失败）'))
  assert.ok(!ok.includes('下一步建议'))
  const failed = composeMarkdown({
    mode: 'detailed',
    sessionId: 's',
    turn: 2,
    reason: { kind: 'error', error: { message: 'boom' } },
    text: '',
    stats: { turn: 2, steps: 1, toolCalls: 1, toolErrors: 1, userText: '', assistantText: '' },
  })
  assert.ok(failed.includes('出错：boom'))
  assert.ok(failed.includes('下一步建议'))
})

await test('smart mode prefers the digest and labels it', () => {
  const markdown = composeMarkdown({
    mode: 'smart',
    sessionId: 's',
    turn: 5,
    reason: { kind: 'completed' },
    text: '很长的原始正文'.repeat(200),
    summary: '改了登录校验并补了测试，全部通过。',
    summaryNote: '子智能体总结 · ≤140 字',
    stats: { turn: 5, steps: 2, toolCalls: 3, toolErrors: 0 },
  })
  assert.ok(markdown.includes('改了登录校验并补了测试，全部通过。'))
  assert.ok(!markdown.includes('很长的原始正文'))
  assert.ok(markdown.includes('子智能体总结 · ≤140 字'))
  assert.ok(markdown.includes('**过程**：2 步 · 3 次工具调用'))
})

await test('smart mode falls back to truncation when the digest is missing', () => {
  const markdown = composeMarkdown({
    mode: 'smart',
    sessionId: 's',
    turn: 5,
    reason: { kind: 'completed' },
    text: '回退正文',
    summary: '',
    summaryNote: '智能总结不可用（timeout），已退回截断',
  })
  assert.ok(markdown.includes('回退正文'))
  assert.ok(markdown.includes('已退回截断'))
})

await test('composeMarkdown reports failures and empty replies', () => {
  const failed = composeMarkdown({ sessionId: 's', turn: 2, reason: { kind: 'error', error: { message: 'boom' } } })
  assert.ok(failed.includes('出错：boom'))
  assert.ok(failed.startsWith('## ❌'))
  const empty = composeMarkdown({ sessionId: 's', turn: 2, reason: { kind: 'aborted', reason: 'user' }, text: '' })
  assert.ok(empty.includes('已中止（user）'))
  assert.ok(empty.includes('_本轮没有文本回复。_'))
})

await test('composeMarkdown stays inside the webhook byte budget', () => {
  for (const mode of MODES) {
    const markdown = composeMarkdown({ mode, sessionId: 's', turn: 1, reason: { kind: 'completed' }, text: 'x'.repeat(20000) })
    assert.ok(Buffer.byteLength(markdown, 'utf8') <= WEBHOOK_MAX_BYTES, `${mode} exceeded the byte budget`)
  }
})

await test('composeSummaryPrompt states the cap and carries the material', () => {
  const prompt = composeSummaryPrompt({
    userText: '把登录改好',
    assistantText: '已经改了并跑了测试',
    title: '登录修复',
    maxChars: 140,
  })
  assert.ok(prompt.includes('140 个字符'))
  assert.ok(prompt.includes('把登录改好'))
  assert.ok(prompt.includes('已经改了并跑了测试'))
  assert.ok(prompt.includes('登录修复'))
  assert.ok(prompt.includes('只输出简报正文'))
})

await test('composeSummaryPrompt keeps oversized material inside its budget', () => {
  const prompt = composeSummaryPrompt({ assistantText: 'x'.repeat(50000), maxInputBytes: 1000 })
  assert.ok(Buffer.byteLength(prompt, 'utf8') < 2000)
})

await test('sendWeComMessage posts a markdown payload once on success', async () => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url: String(url), body: JSON.parse(options.body), method: options.method })
    return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
  }
  const result = await sendWeComMessage({
    webhookUrl: WEBHOOK,
    content: 'body',
    mentionedMobileList: ['@all'],
    fetchImpl,
  })
  assert.equal(result.ok, true)
  assert.equal(calls.length, 1)
  assert.equal(calls[0].method, 'POST')
  assert.deepEqual(calls[0].body, {
    msgtype: 'markdown',
    markdown: { content: 'body', mentioned_mobile_list: ['@all'] },
  })
})

await test('sendWeComMessage retries a network failure and then succeeds', async () => {
  let attempt = 0
  const fetchImpl = async () => {
    attempt += 1
    if (attempt === 1) throw new Error('ECONNRESET')
    return new Response(JSON.stringify({ errcode: 0 }), { status: 200 })
  }
  const result = await sendWeComMessage({ webhookUrl: WEBHOOK, content: 'x', fetchImpl, retryDelayMs: 1 })
  assert.equal(result.ok, true)
  assert.equal(attempt, 2)
})

await test('sendWeComMessage does not retry a refused key', async () => {
  let attempt = 0
  const fetchImpl = async () => {
    attempt += 1
    return new Response(JSON.stringify({ errcode: 93000, errmsg: 'invalid webhook url' }), { status: 200 })
  }
  const result = await sendWeComMessage({ webhookUrl: WEBHOOK, content: 'x', fetchImpl, retryDelayMs: 1 })
  assert.equal(result.ok, false)
  assert.equal(result.code, 93000)
  assert.equal(attempt, 1)
})

await test('sendWeComMessage reports a bad webhook without any request', async () => {
  let called = false
  const result = await sendWeComMessage({
    webhookUrl: 'https://example.com/hook',
    content: 'x',
    fetchImpl: async () => { called = true; return new Response('{}', { status: 200 }) },
  })
  assert.equal(result.ok, false)
  assert.equal(called, false)
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
