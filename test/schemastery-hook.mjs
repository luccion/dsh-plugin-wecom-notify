/**
 * Test-only ESM resolve hook for `@deepseek-ai/schemastery`.
 *
 * In a normal checkout this is a no-op: `pnpm install` puts the dependency in
 * ./node_modules and Node resolves it natively. The fallbacks exist only for
 * running these tests straight from a DSH workspace, where the package may live
 * in the workspace's own node_modules or in the DSH app payload.
 *
 * Override with DSH_SCHEMASTERY_PATH to point at an existing build.
 */
import { existsSync, mkdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const pkgRoot = resolvePath(here, '..')
const workspace = resolvePath(pkgRoot, '..', '..')

/** A package directory that contains a usable build. */
function usable(dir) {
  return dir !== undefined && existsSync(join(dir, 'lib', 'index.mjs'))
}

function candidateFromNode() {
  try {
    const require = createRequire(join(pkgRoot, 'package.json'))
    const entry = require.resolve('@deepseek-ai/schemastery')
    const dir = dirname(dirname(entry))
    return usable(dir) ? dir : undefined
  } catch {
    return undefined
  }
}

function candidateFromCache() {
  const cache = process.env.DSH_TEST_PKG_CACHE ?? join(workspace, '.dsh-tools', 'pkg-cache')
  const dir = join(cache, 'node_modules', '@deepseek-ai', 'schemastery')
  if (usable(dir)) return dir
  const grabber = join(workspace, '.dsh-tools', 'asar-grab.js')
  const asar = process.env.DSH_ASAR_PATH
    ?? 'C:\\Users\\lucci\\AppData\\Local\\Programs\\DeepSeek Harness\\resources\\app.asar'
  if (!existsSync(grabber) || !existsSync(asar)) return undefined
  mkdirSync(cache, { recursive: true })
  spawnSync(process.execPath, [grabber, asar, 'node_modules/@deepseek-ai/schemastery/', cache], { stdio: 'ignore' })
  spawnSync(process.execPath, [grabber, asar, 'node_modules/@deepseek-ai/cosmokit/', cache], { stdio: 'ignore' })
  return usable(dir) ? dir : undefined
}

const resolved = process.env.DSH_SCHEMASTERY_PATH
  ?? candidateFromNode()
  ?? candidateFromCache()

export function resolve(specifier, context, nextResolve) {
  if (specifier === '@deepseek-ai/schemastery' && resolved !== undefined) {
    return { url: pathToFileURL(join(resolved, 'lib', 'index.mjs')).href, shortCircuit: true }
  }
  return nextResolve(specifier, context)
}
