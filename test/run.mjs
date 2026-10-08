/**
 * Dependency-free checks for the WeCom turn-notification plugin.
 * Run: node test/run.mjs
 */
import assert from 'node:assert/strict'
import {
  WEBHOOK_MAX_BYTES,
  checkWebhook,
  composeMarkdown,
  contentToText,
  readLastAssistantText,
  readSessionTitle,
  redactWebhook,
  sendWeComMessage,
  truncateBytes,
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

await test('readSessionTitle prefers the title service, then the log', () => {
  const session = { log: [{ type: 'session/title', data: { title: 'from-log' } }] }
  assert.equal(readSessionTitle({ sessionTitle: { get: () => 'from-service' } }, session), 'from-service')
  assert.equal(readSessionTitle({}, session), 'from-log')
  assert.equal(readSessionTitle({}, { log: [] }), '')
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
  assert.ok(markdown.startsWith('## DSH 对话完成'))
  assert.ok(markdown.includes('**会话**：修复登录问题'))
  assert.ok(markdown.includes('**会话 ID**：session-1'))
  assert.ok(markdown.includes('第 3 轮'))
  assert.ok(markdown.includes('已完成'))
  assert.ok(markdown.includes('已经改好并跑过测试了。'))
  assert.ok(markdown.includes('<@13800000000>'))
})

await test('composeMarkdown reports failures and empty replies', () => {
  const failed = composeMarkdown({ sessionId: 's', turn: 2, reason: { kind: 'error', error: { message: 'boom' } } })
  assert.ok(failed.includes('出错：boom'))
  const empty = composeMarkdown({ sessionId: 's', turn: 2, reason: { kind: 'aborted', reason: 'user' }, text: '' })
  assert.ok(empty.includes('已中止（user）'))
  assert.ok(empty.includes('_本轮没有文本回复。_'))
})

await test('composeMarkdown stays inside the webhook byte budget', () => {
  const markdown = composeMarkdown({ sessionId: 's', turn: 1, reason: { kind: 'completed' }, text: 'x'.repeat(10000) })
  assert.ok(Buffer.byteLength(markdown, 'utf8') <= WEBHOOK_MAX_BYTES)
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
