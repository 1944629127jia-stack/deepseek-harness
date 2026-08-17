/**
 * Smoke-test the staged runtime before it gets packaged.
 *
 * Boots `desktop/runtime/lib/bin.js web --port 0` through the local Electron
 * binary in ELECTRON_RUN_AS_NODE mode — the exact launch path the packaged
 * app uses, embedded Node version included — then requires the readiness
 * line, an HTTP 200 index, and the injected boot manifest. Any failure exits
 * nonzero so `npm run dist` refuses to build an installer from a bad tree.
 *
 * Usage: node desktop/scripts/smoke-runtime.mjs   (from the repository root)
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const RUNTIME = join(ROOT, 'desktop', 'runtime')
const CLI_BIN = join(RUNTIME, 'lib', 'bin.js')
const ELECTRON = join(ROOT, 'desktop', 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
const URL_LINE = /dsh web: (https?:\/\/\S+)/
const BOOT_TIMEOUT_MS = 120_000

function fail(message, output) {
  console.error(`smoke-runtime: FAIL — ${message}`)
  if (output) console.error(`--- harness output tail ---\n${output.slice(-3000)}`)
  process.exitCode = 1
}

if (!existsSync(CLI_BIN)) {
  fail(`staged runtime missing (${CLI_BIN}); run stage-runtime.mjs first`)
  process.exit()
}
if (!existsSync(ELECTRON)) {
  fail(`electron binary missing (${ELECTRON}); run npm install in desktop/ first`)
  process.exit()
}

const child = spawn(ELECTRON, ['--expose-internals', CLI_BIN, 'web', '--port', '0'], {
  cwd: RUNTIME,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: ['ignore', 'pipe', 'pipe'],
})

let output = ''
child.stdout.on('data', chunk => { output += String(chunk) })
child.stderr.on('data', chunk => { output += String(chunk) })

function stopChild() {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  child.kill('SIGTERM')
  return Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    // Windows delivers no SIGTERM to console-detached children; escalate.
    new Promise(resolve => setTimeout(resolve, 6000)).then(() => { child.kill('SIGKILL') }),
  ])
}

const deadline = Date.now() + BOOT_TIMEOUT_MS
let url
while (Date.now() < deadline) {
  url = URL_LINE.exec(output)?.[1]
  if (url) break
  if (child.exitCode !== null) break
  await new Promise(resolve => setTimeout(resolve, 500))
}

if (!url) {
  fail(child.exitCode !== null ? `harness exited (${child.exitCode}) before printing its URL` : 'no readiness line within timeout', output)
  await stopChild()
  process.exit()
}

try {
  const response = await fetch(`${url}/`, { signal: AbortSignal.timeout(10_000) })
  const body = await response.text()
  if (response.status !== 200) {
    fail(`index answered HTTP ${response.status}`, output)
  } else if (!body.includes('__DSH_BOOT__')) {
    fail('index missing the injected __DSH_BOOT__ manifest', output)
  }
} catch (error) {
  fail(`index unreachable: ${String(error)}`, output)
}

await stopChild()
if (process.exitCode) process.exit()
console.log(`smoke-runtime: OK — staged runtime served the GUI at ${url} via Electron-embedded Node`)
