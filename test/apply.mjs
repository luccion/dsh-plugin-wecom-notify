/**
 * Wiring checks: the plugin's apply() against a fake Cordis context, plus the
 * Config schema it publishes. Run: node test/apply.mjs
 */
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { pathToFileURL } from 'node:url'

// The DSH runtime resolves @deepseek-ai/* for plugins; a plain `node` run from
// the checkout does not. Point that one specifier at the copy extracted from the
// app payload so this wiring test needs no install.
if (!process.env.DSH_WECOM_TEST_NO_HOOK) {
  register('./schemastery-hook.mjs', import.meta.url)
}

let passed = 0
const failures = []

async function test(title, fn) {
  try {
    await fn()
    passed += 1
    console.log(`  ok  ${title}`)
  } catch (error) {
    failures.push({ title, error })
    console.log(`FAIL  ${title}\n      ${error?.stack ?? error}`)
  }
}

const sent = []
globalThis.fetch = async (url, options) => {
  sent.push({ url: String(url), body: JSON.parse(options.body) })
  return new Response(JSON.stringify({ errcode: 0, errmsg: 'ok' }), { status: 200 })
}

const { apply, Config, name } = await import('../index.js')

function fakeContext() {
  const listeners = new Map()
  const timers = new Set()
  const warnings = []
  const infos = []
  return {
    logger: {
      info: (...args) => infos.push(args.map(String).join(' ')),
      warn: (...args) => warnings.push(args.map(String).join(' ')),
      debug: () => {},
    },
    warnings,
    infos,
    agents: {
      roots: () => [{ id: 'root-session' }],
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    effect(factory) {
      const disposer = factory()
      timers.add(disposer)
      return disposer
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
    disposeAll() {
      for (const disposer of timers) disposer()
    },
  }
}

const sessionLog = [
  { type: 'session/title', data: { title: '测试会话' } },
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '本轮答案' }] } } },
]

function turnEndEvent(turn) {
  return { type: 'turn/end', seq: turn * 4, time: 1_700_000_000_000 + turn, data: { turn, reason: { kind: 'completed' } } }
}

await test('exports a Cordis plugin name and a schema', () => {
  assert.equal(name, 'wecom-turn-notify')
  assert.equal(typeof apply, 'function')
  assert.equal(typeof Config, 'function')
})

await test('Config fills in every default', () => {
  const config = new Config({})
  assert.equal(config.enabled, true)
  assert.equal(config.rootsOnly, true)
  assert.equal(config.webhookUrl, '')
  assert.equal(config.heading, 'DSH 对话完成')
  assert.deepEqual(config.mentionList, [])
  assert.equal(config.maxContentBytes, 1200)
  assert.equal(config.debounceMs, 1500)
  assert.equal(config.minIntervalMs, 3000)
  assert.equal(config.attempts, 3)
})

await test('Config rejects a wrong type', () => {
  assert.throws(() => new Config({ debounceMs: 'soon' }))
})

await test('one finished turn produces exactly one message', async () => {
  sent.length = 0
  const ctx = fakeContext()
  apply(ctx, new Config({ webhookUrl: 'https://example.com/hook?key=k', debounceMs: 10, minIntervalMs: 0 }))
  const session = { id: 'root-session', log: sessionLog }
  // The live path and the durable path both report the same turn.
  ctx.emit('agent/turn-stopping', { agent: { id: 'root-session', session }, turn: 1 })
  ctx.emit('session/event', session, turnEndEvent(1))
  await new Promise((resolve) => setTimeout(resolve, 120))
  assert.equal(sent.length, 1)
  assert.match(sent[0].body.markdown.content, /测试会话/)
  assert.match(sent[0].body.markdown.content, /本轮答案/)
})

await test('subagent sessions are skipped while rootsOnly is on', async () => {
  sent.length = 0
  const ctx = fakeContext()
  apply(ctx, new Config({ webhookUrl: 'https://example.com/hook?key=k', debounceMs: 10, minIntervalMs: 0 }))
  const session = { id: 'child-session', log: sessionLog }
  ctx.emit('session/event', session, turnEndEvent(1))
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(sent.length, 0)
})

await test('rootsOnly: false also notifies child sessions', async () => {
  sent.length = 0
  const ctx = fakeContext()
  apply(ctx, new Config({ webhookUrl: 'https://example.com/hook?key=k', rootsOnly: false, debounceMs: 10, minIntervalMs: 0 }))
  const session = { id: 'child-session', log: sessionLog }
  ctx.emit('session/event', session, turnEndEvent(1))
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(sent.length, 1)
})

await test('two different turns produce two messages', async () => {
  sent.length = 0
  const ctx = fakeContext()
  apply(ctx, new Config({ webhookUrl: 'https://example.com/hook?key=k', debounceMs: 10, minIntervalMs: 0 }))
  const session = { id: 'root-session', log: sessionLog }
  ctx.emit('session/event', session, turnEndEvent(1))
  await new Promise((resolve) => setTimeout(resolve, 60))
  ctx.emit('session/event', session, turnEndEvent(2))
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(sent.length, 2)
  assert.match(sent[1].body.markdown.content, /第 2 轮/)
})

await test('an empty webhookUrl logs a warning and sends nothing', async () => {
  sent.length = 0
  const ctx = fakeContext()
  apply(ctx, new Config({ debounceMs: 10, minIntervalMs: 0 }))
  assert.ok(ctx.warnings.some((line) => line.includes('webhookUrl')))
  const session = { id: 'root-session', log: sessionLog }
  ctx.emit('session/event', session, turnEndEvent(1))
  await new Promise((resolve) => setTimeout(resolve, 60))
  assert.equal(sent.length, 0)
  assert.ok(ctx.infos.some((line) => line.includes('dry-run')))
})

await test('a disabled plugin registers nothing', async () => {
  sent.length = 0
  const ctx = fakeContext()
  apply(ctx, new Config({ enabled: false, webhookUrl: 'https://example.com/hook?key=k' }))
  const session = { id: 'root-session', log: sessionLog }
  ctx.emit('session/event', session, turnEndEvent(1))
  await new Promise((resolve) => setTimeout(resolve, 40))
  assert.equal(sent.length, 0)
})

await test('the webhook key never reaches the log', async () => {
  const ctx = fakeContext()
  apply(ctx, new Config({ webhookUrl: 'https://example.com/hook?key=super-secret', debounceMs: 10, minIntervalMs: 0 }))
  assert.ok(ctx.infos.every((line) => !line.includes('super-secret')))
  assert.ok(ctx.infos.some((line) => line.includes('key=***')))
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
