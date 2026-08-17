/**
 * Stage the dsh runtime closure for the Electron installer.
 *
 * Produces `desktop/runtime/`: a symlink-free flat node_modules tree holding
 * the full dependency closure of the `@deepseek-ai/dsh` CLI (including the
 * web frontend dist), plus the CLI package itself at the root so the entry
 * stays `runtime/lib/bin.js`.
 *
 * Why not `pnpm deploy`: the repo's own experience (python SDK runtime) is
 * that pnpm's legacy deploy silently drops transitive workspace packages —
 * python/sdk-runtime declares 108 explicit deps to compensate. Walking the
 * installed tree with Node resolution and copying dereferenced packages is
 * deterministic and needs no maintained manifest.
 *
 * Usage: node desktop/scripts/stage-runtime.mjs   (from the repository root,
 * after `pnpm install && pnpm run build`)
 */

import { existsSync, lstatSync, readdirSync, realpathSync } from 'node:fs'
import { cp, mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { dirname, join, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../..', import.meta.url))
const STAGING = join(ROOT, 'desktop', 'runtime')
/** The deploy root: the dsh CLI workspace package. */
const CLI_PACKAGE = join(ROOT, 'apps', 'cli')

/** Run one command, inheriting stdio; throw on failure. */
function run(command, args, cwd = ROOT) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
  if (result.status !== 0) throw new Error(`stage-runtime: command failed (${String(result.status)}): ${command} ${args.join(' ')}`)
}

/** Copy a package directory dereferenced, skipping nested node_modules. */
async function copyPackage(source, destination) {
  await mkdir(dirname(destination), { recursive: true })
  const nestedNodeModules = join(source, 'node_modules')
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: path => path !== nestedNodeModules && !path.startsWith(nestedNodeModules + sep),
  })
}

/**
 * Resolve dependency `name` from package directory `packageDir` the way Node
 * does — every ancestor's node_modules — returning the real (de-symlinked)
 * package directory, or undefined when unresolvable.
 */
function resolvePackage(packageDir, name) {
  let dir = packageDir
  while (dir.startsWith(ROOT)) {
    const candidate = join(dir, 'node_modules', name)
    if (existsSync(candidate)) return realpathSync(candidate)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return undefined
}

/** Read a package manifest, throwing with context on failure. */
async function readManifest(packageDir) {
  try {
    return JSON.parse(await readFile(join(packageDir, 'package.json'), 'utf8'))
  } catch (error) {
    throw new Error(`stage-runtime: cannot read manifest in ${packageDir}: ${String(error)}`)
  }
}

const OPTIONAL_FALLBACK_NOTE = 'unresolvable names are assumed optional peers'
const CLI_PACKAGE_REAL = await realpath(CLI_PACKAGE)

/**
 * Walk the dependency graph from the CLI package and copy every reachable
 * package into the staging node_modules. One realpath per name wins the flat
 * top-level slot; every other version is nested under each requirer's
 * node_modules, mirroring how Node would resolve it in the source tree.
 */
async function stageClosure() {
  /** realpath → display name (for reports) */
  const seen = new Map()
  /** graph edges: requirer realpath → Map(depName → dep realpath) */
  const edges = new Map()
  const missing = []
  const queue = [CLI_PACKAGE]

  while (queue.length > 0) {
    const real = await realpath(queue.shift())
    if (seen.has(real)) continue
    seen.set(real, undefined)
    const manifest = await readManifest(real)
    const dependencies = {
      ...manifest.peerDependencies,
      ...manifest.optionalDependencies,
      ...manifest.dependencies,
    }
    const resolvedDeps = new Map()
    for (const dependency of Object.keys(dependencies)) {
      const resolved = resolvePackage(real, dependency)
      if (resolved === undefined) {
        missing.push(`${dependency} (required by ${real})`)
        continue
      }
      resolvedDeps.set(dependency, resolved)
      if (!seen.has(resolved)) queue.push(resolved)
    }
    edges.set(real, resolvedDeps)
  }

  // Top-level winners: first-seen realpath per name (BFS order ≈ closeness
  // to the CLI root, so the primary instance stays flat).
  const topLevel = new Map()
  for (const deps of edges.values()) {
    for (const [name, real] of deps) {
      if (!topLevel.has(name)) topLevel.set(name, real)
    }
  }

  // Placements: realpath → set of staging paths it must be copied to.
  // Seeded with top-level winners; nested copies propagate to fixpoint.
  /** @type {Map<string, Set<string>>} */
  const placements = new Map()
  for (const [name, real] of topLevel) {
    if (!placements.has(real)) placements.set(real, new Set())
    placements.get(real).add(join(STAGING, 'node_modules', ...name.split('/')))
  }
  let grew = true
  while (grew) {
    grew = false
    for (const [requirer, deps] of edges) {
      const requirerPaths = requirer === CLI_PACKAGE_REAL
        ? [STAGING]
        : [...(placements.get(requirer) ?? [])]
      for (const [name, depReal] of deps) {
        if (topLevel.get(name) === depReal) continue
        for (const requirerPath of requirerPaths) {
          const target = join(requirerPath, 'node_modules', ...name.split('/'))
          if (!placements.has(depReal)) placements.set(depReal, new Set())
          if (!placements.get(depReal).has(target)) {
            placements.get(depReal).add(target)
            grew = true
          }
        }
      }
    }
  }

  let copies = 0
  for (const [real, targets] of placements) {
    for (const target of targets) {
      await copyPackage(real, target)
      copies += 1
    }
  }
  return { staged: seen, missing, copies }
}

if (!resolvePackage(CLI_PACKAGE, '@deepseek-ai/cordis')) {
  throw new Error('stage-runtime: workspace not installed; run pnpm install && pnpm run build first')
}

// Keep the installer's version in lockstep with the harness: electron-builder
// names artifacts and decides upgrade/downgrade behavior from this field.
const cliManifest = JSON.parse(await readFile(join(CLI_PACKAGE, 'package.json'), 'utf8'))
const desktopManifestPath = join(ROOT, 'desktop', 'package.json')
const desktopManifest = JSON.parse(await readFile(desktopManifestPath, 'utf8'))
if (desktopManifest.version !== cliManifest.version) {
  desktopManifest.version = cliManifest.version
  await writeFile(desktopManifestPath, `${JSON.stringify(desktopManifest, null, 2)}\n`)
  console.log(`stage-runtime: synced desktop version to ${cliManifest.version}`)
}

await rm(STAGING, { recursive: true, force: true })
await mkdir(join(STAGING, 'node_modules'), { recursive: true })

// The CLI package itself sits at the staging root (bin stays lib/bin.js).
await copyPackage(CLI_PACKAGE, STAGING)
for (const doc of ['README.md', 'README.zh.md', 'README.i18n.yaml']) {
  await rm(join(STAGING, doc), { force: true })
}

const { staged, missing } = await stageClosure()
if (missing.length > 0) {
  console.warn(`stage-runtime: ${OPTIONAL_FALLBACK_NOTE}:\n  ${missing.join('\n  ')}`)
}

for (const required of ['lib/bin.js', 'node_modules/@deepseek-ai/dsh-web-frontend/dist/index.html']) {
  if (!existsSync(join(STAGING, required))) throw new Error(`stage-runtime: staged closure misses ${required}`)
}

// The local background plugin ships beside the runtime: the shell copies it
// into the booted profile's node_modules on launch (packaged machines have no
// pnpm to run `dsh plugin add`).
const PLUGIN_DIR = join(ROOT, 'desktop', 'background-plugin')
console.log('stage-runtime: building dsh-ui-background')
run(join(ROOT, 'node_modules', '.bin', 'tsdown'), [], PLUGIN_DIR)
await cp(PLUGIN_DIR, join(STAGING, 'plugin', 'dsh-ui-background'), {
  recursive: true,
  filter: path => !path.includes('node_modules'),
})
await cp(join(PLUGIN_DIR, 'overlay.yml'), join(STAGING, 'background-overlay.yml'))

const count = readdirSync(join(STAGING, 'node_modules'), { withFileTypes: true })
  .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
  .length
console.log(`stage-runtime: staged ${String(staged.size)} packages (${String(count)} top-level) at ${STAGING}`)
