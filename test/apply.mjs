/**
 * Wiring checks: the plugin's apply() against a fake Cordis context, the Config
 * schema it publishes, and the four notification modes. Run: node test/apply.mjs
 */
import assert from 'node:assert/strict'
import { register } from 'node:module'

// A plain `node` run resolves @deepseek-ai/schemastery from ./node_modules after
// `pnpm install`; the hook only adds fallbacks for running from a DSH workspace.
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

const SESSION_LOG = [
  { type: 'session/title', data: { title: '测试会话' } },
  { type: 'turn/start', data: { turn: 1 } },
  { type: 'user/message', data: { content: [{ type: 'text', text: '帮我把登录改好' }] } },
  { type: 'step/start', data: { turn: 1, step: 1 } },
  { type: 'tool/call', data: { turn: 1, name: 'read' } },
  { type: 'tool/result', data: { turn: 1, message: { content: [{ type: 'text', text: 'ok' }] } } },
  { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '本轮答案' }] } } },
]

/** A fake subagent service that records what it was asked to do. */
function fakeSubagents({ result = '子智能体写出的简报。', stopReason = 'completed', fail = false } = {}) {
  const calls = []
  return {
    calls,
    list: () => ['spawn'],
    getProvider: () => ({ capabilities: { agentOptions: true, toolFilter: true, persona: true, depthLimit: true } }),
    async start(provider, request) {
      calls.push({ provider, request })
      if (fail) throw new Error('provider exploded')
      return {
        id: 'child-session',
        localAgent: undefined,
        result: Promise.resolve({
          output: result === '' ? [] : [{ type: 'text', text: result }],
          stopReason,
        }),
        dispose: async () => {},
      }
    },
  }
}

function fakeContext({ subagents } = {}) {
  const listeners = new Map()
  const disposers = new Set()
  const warnings = []
  const infos = []
  const ctx = {
    logger: {
      info: (...args) => infos.push(args.map(String).join(' ')),
      warn: (...args) => warnings.push(args.map(String).join(' ')),
      debug: () => {},
    },
    warnings,
    infos,
    agents: {
      roots: () => [{ id: 'root-session' }],
      get: (id) => (id === 'root-session' ? { id, session: { id } } : undefined),
    },
    on(event, handler) {
      const list = listeners.get(event) ?? []
      list.push(handler)
      listeners.set(event, list)
    },
    effect(factory) {
      disposers.add(factory())
      return () => {}
    },
    emit(event, ...args) {
      for (const handler of listeners.get(event) ?? []) handler(...args)
    },
    disposeAll() {
      for (const disposer of disposers) disposer()
    },
  }
  if (subagents !== undefined) ctx.subagents = subagents
  return ctx
}

const FAST = { webhookUrl: 'https://example.com/hook?key=k', debounceMs: 10, minIntervalMs: 0 }
const settle = (ms = 120) => new Promise((resolve) => setTimeout(resolve, ms))

function turnEndEvent(turn, reason = { kind: 'completed' }) {
  return { type: 'turn/end', seq: turn * 4, time: 1_700_000_000_000 + turn, data: { turn, reason } }
}

function lastContent() {
  return sent[sent.length - 1]?.body.markdown.content ?? ''
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
  assert.equal(config.mode, 'normal')
  assert.equal(config.heading, 'DSH 对话完成')
  assert.deepEqual(config.mentionList, [])
  assert.equal(config.maxContentBytes, 0)
  assert.equal(config.summaryChars, 140)
  assert.equal(config.summaryProvider, 'spawn')
  assert.equal(config.summaryModel, '')
  assert.equal(config.summaryTimeoutMs, 60000)
  assert.equal(config.debounceMs, 1500)
  assert.equal(config.minIntervalMs, 3000)
  assert.equal(config.attempts, 3)
})

await test('Config accepts exactly the four modes and rejects anything else', () => {
  for (const mode of ['status', 'normal', 'detailed', 'smart']) {
    assert.equal(new Config({ mode }).mode, mode)
  }
  assert.throws(() => new Config({ mode: 'verbose' }))
  assert.throws(() => new Config({ mode: 'SMART' }))
})

await test('summaryChars takes a number or "model"', () => {
  assert.equal(new Config({ summaryChars: 80 }).summaryChars, 80)
  assert.equal(new Config({ summaryChars: 'model' }).summaryChars, 'model')
  assert.throws(() => new Config({ summaryChars: -1 }))
  assert.throws(() => new Config({ summaryChars: 'auto' }))
})

await test('one finished turn produces exactly one message', async () => {
  sent.length = 0
  const ctx = fakeContext()
  apply(ctx, new Config(FAST))
  const session = { id: 'root-session', log: SESSION_LOG }
  ctx.emit('agent/turn-stopping', { agent: { id: 'root-session', session }, turn: 1 })
  ctx.emit('session/event', session, turnEndEvent(1))
  await settle()
  assert.equal(sent.length, 1)
  assert.match(lastContent(), /测试会话/)
  assert.match(lastContent(), /本轮答案/)
})

await test('subagent sessions are skipped while rootsOnly is on', async () => {
  sent.length = 0
  const ctx = fakeContext()
  apply(ctx, new Config(FAST))
  const session = { id: 'child-session', log: SESSION_LOG }
  ctx.emit('session/event', session, turnEndEvent(1))
  await settle(60)
  assert.equal(sent.length, 0)
})

await test('status mode sends status only, with no body', async () => {
  sent.length = 0
  const ctx = fakeContext()
  apply(ctx, new Config({ ...FAST, mode: 'status' }))
  ctx.emit('session/event', { id: 'root-session', log: SESSION_LOG }, turnEndEvent(1))
  await settle()
  assert.equal(sent.length, 1)
  assert.match(lastContent(), /第 1 轮/)
  assert.match(lastContent(), /已完成/)
  assert.ok(!lastContent().includes('本轮答案'))
})

await test('detailed mode adds the process line', async () => {
  sent.length = 0
  const ctx = fakeContext()
  apply(ctx, new Config({ ...FAST, mode: 'detailed' }))
  ctx.emit('session/event', { id: 'root-session', log: SESSION_LOG }, turnEndEvent(1))
  await settle()
  assert.match(lastContent(), /\*\*过程\*\*：1 步 · 1 次工具调用/)
  assert.match(lastContent(), /本轮答案/)
})

await test('smart mode asks a subagent and sends its digest', async () => {
  sent.length = 0
  const subagents = fakeSubagents({ result: '登录校验已改好，测试全绿。' })
  const ctx = fakeContext({ subagents })
  apply(ctx, new Config({ ...FAST, mode: 'smart', summaryChars: 140 }))
  const session = { id: 'root-session', log: SESSION_LOG }
  ctx.emit('agent/turn-stopping', { agent: { id: 'root-session', session }, turn: 1 })
  ctx.emit('session/event', session, turnEndEvent(1))
  await settle(200)
  assert.equal(sent.length, 1)
  assert.match(lastContent(), /登录校验已改好，测试全绿。/)
  assert.match(lastContent(), /子智能体总结 · ≤140 字/)
  assert.ok(!lastContent().includes('本轮答案'))
  assert.equal(subagents.calls.length, 1)
  const request = subagents.calls[0].request
  assert.equal(subagents.calls[0].provider, 'spawn')
  assert.deepEqual(request.toolFilter, { allow: [] })
  assert.equal(request.maxDepth, 1)
  assert.equal(typeof request.persona, 'string')
  assert.equal(request.prompt[0].type, 'text')
  assert.match(request.prompt[0].text, /140 个字符/)
  assert.match(request.prompt[0].text, /帮我把登录改好/)
})

await test('smart mode enforces the character cap itself', async () => {
  sent.length = 0
  const subagents = fakeSubagents({ result: '很长'.repeat(200) })
  const ctx = fakeContext({ subagents })
  apply(ctx, new Config({ ...FAST, mode: 'smart', summaryChars: 20 }))
  const session = { id: 'root-session', log: SESSION_LOG }
  ctx.emit('agent/turn-stopping', { agent: { id: 'root-session', session }, turn: 1 })
  ctx.emit('session/event', session, turnEndEvent(1))
  await settle(200)
  const body = lastContent()
  assert.match(body, /≤20 字/)
  const digestLine = body.split('\n').find((line) => line.startsWith('很长'))
  assert.ok(digestLine, 'expected the digest to be present')
  assert.ok([...digestLine].length <= 21, `digest not capped: ${digestLine.length}`)
})

await test('summaryChars "model" trusts the model and omits the cap hint', async () => {
  sent.length = 0
  const subagents = fakeSubagents({ result: '由模型自己决定长度。' })
  const ctx = fakeContext({ subagents })
  apply(ctx, new Config({ ...FAST, mode: 'smart', summaryChars: 'model' }))
  const session = { id: 'root-session', log: SESSION_LOG }
  ctx.emit('agent/turn-stopping', { agent: { id: 'root-session', session }, turn: 1 })
  ctx.emit('session/event', session, turnEndEvent(1))
  await settle(200)
  assert.match(lastContent(), /由模型自己决定长度。/)
  assert.match(lastContent(), /子智能体总结/)
  assert.ok(!lastContent().includes('≤'))
})

await test('smart mode falls back to truncation when the subagent fails', async () => {
  sent.length = 0
  const ctx = fakeContext({ subagents: fakeSubagents({ fail: true }) })
  apply(ctx, new Config({ ...FAST, mode: 'smart' }))
  const session = { id: 'root-session', log: SESSION_LOG }
  ctx.emit('agent/turn-stopping', { agent: { id: 'root-session', session }, turn: 1 })
  ctx.emit('session/event', session, turnEndEvent(1))
  await settle(200)
  assert.equal(sent.length, 1)
  assert.match(lastContent(), /本轮答案/)
  assert.match(lastContent(), /智能总结不可用/)
})

await test('smart mode falls back when no subagent service exists', async () => {
  sent.length = 0
  const ctx = fakeContext()
  apply(ctx, new Config({ ...FAST, mode: 'smart' }))
  const session = { id: 'root-session', log: SESSION_LOG }
  ctx.emit('agent/turn-stopping', { agent: { id: 'root-session', session }, turn: 1 })
  ctx.emit('session/event', session, turnEndEvent(1))
  await settle(200)
  assert.equal(sent.length, 1)
  assert.match(lastContent(), /智能总结不可用（subagent service unavailable）/)
})

await test('smart mode skips the subagent when the digest cannot be sent anyway', async () => {
  sent.length = 0
  const subagents = fakeSubagents()
  const ctx = fakeContext({ subagents })
  apply(ctx, new Config({ ...FAST, webhookUrl: '', mode: 'smart' }))
  ctx.emit('session/event', { id: 'root-session', log: SESSION_LOG }, turnEndEvent(1))
  await settle(150)
  assert.equal(sent.length, 0)
  assert.equal(subagents.calls.length, 0)
  assert.ok(ctx.infos.some((line) => line.includes('dry-run')))
})

await test('maxContentBytes overrides the mode budget', async () => {
  sent.length = 0
  const ctx = fakeContext()
  apply(ctx, new Config({ ...FAST, mode: 'normal', maxContentBytes: 24 }))
  const log = [...SESSION_LOG, { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'y'.repeat(500) }] } } }]
  ctx.emit('session/event', { id: 'root-session', log }, turnEndEvent(1))
  await settle()
  assert.ok(lastContent().includes('…'))
  assert.ok(Buffer.byteLength(lastContent(), 'utf8') < 600)
})

await test('two different turns produce two messages', async () => {
  sent.length = 0
  const ctx = fakeContext()
  apply(ctx, new Config(FAST))
  const session = { id: 'root-session', log: SESSION_LOG }
  ctx.emit('session/event', session, turnEndEvent(1))
  await settle(60)
  ctx.emit('session/event', session, turnEndEvent(2))
  await settle(60)
  assert.equal(sent.length, 2)
  assert.match(lastContent(), /第 2 轮/)
})

await test('an empty webhookUrl logs a warning and sends nothing', async () => {
  sent.length = 0
  const ctx = fakeContext()
  apply(ctx, new Config({ ...FAST, webhookUrl: '' }))
  assert.ok(ctx.warnings.some((line) => line.includes('webhookUrl')))
  ctx.emit('session/event', { id: 'root-session', log: SESSION_LOG }, turnEndEvent(1))
  await settle(60)
  assert.equal(sent.length, 0)
  assert.ok(ctx.infos.some((line) => line.includes('dry-run')))
})

await test('a disabled plugin registers nothing', async () => {
  sent.length = 0
  const ctx = fakeContext()
  apply(ctx, new Config({ ...FAST, enabled: false }))
  ctx.emit('session/event', { id: 'root-session', log: SESSION_LOG }, turnEndEvent(1))
  await settle(40)
  assert.equal(sent.length, 0)
})

await test('the webhook key never reaches the log', async () => {
  const ctx = fakeContext()
  apply(ctx, new Config({ ...FAST, webhookUrl: 'https://example.com/hook?key=super-secret' }))
  assert.ok(ctx.infos.every((line) => !line.includes('super-secret')))
  assert.ok(ctx.infos.some((line) => line.includes('key=***')))
})

console.log(`\n${passed} passed, ${failures.length} failed`)
if (failures.length > 0) process.exitCode = 1
