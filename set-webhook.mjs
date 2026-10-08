// node set-webhook.mjs <webhookUrl> [profileDir]
// Write the group-robot webhook into the profile patch, keeping the file valid
// YAML and the entry's module path untouched. Pass an empty string to clear it.
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const webhookUrl = process.argv[2] ?? ''
const profileDir = process.argv[3] ?? 'C:\\Users\\lucci\\.dsh\\profiles\\desktop'
const patch = join(profileDir, 'cordis.patch.yml')

if (webhookUrl !== '' && !/^https?:\/\/[^\s'"]+\?key=[^\s'"]+$/.test(webhookUrl)) {
  console.error('refusing: expected a URL of the form https://qyapi.weixin.qq.com/cgi-bin/webhook/send?key=...')
  process.exit(1)
}

const lines = readFileSync(patch, 'utf8').split('\n')
let inBlock = false
let replaced = false
let sawEntry = false

const out = lines.map((line) => {
  if (/^\s+- id: wecom-turn-notify\s*$/.test(line)) { inBlock = true; sawEntry = true; return line }
  if (inBlock && /^\s+- id: /.test(line)) inBlock = false
  if (inBlock && /^\s+webhookUrl\s*:/.test(line)) {
    replaced = true
    return `        webhookUrl: '${webhookUrl}'`
  }
  return line
})

if (!sawEntry) throw new Error(`entry wecom-turn-notify not found in ${patch}`)

const text = out.join('\n')
// Cheap structural guard before writing: the entry, its name, and its config must survive.
if (!/^\s+- id: wecom-turn-notify$/m.test(text) || !/^\s+name:/m.test(text) || !/^\s+config:$/m.test(text)) {
  throw new Error('refusing to write: the entry structure changed unexpectedly')
}
writeFileSync(patch, text, 'utf8')

console.log(replaced
  ? `webhookUrl set to ${webhookUrl === '' ? '(empty)' : webhookUrl}`
  : `no webhookUrl line found; add "        webhookUrl: '${webhookUrl}'" under the entry's config`)
console.log('profile patch:', patch)
