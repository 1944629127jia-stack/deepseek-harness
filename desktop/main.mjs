/**
 * dsh-desktop-shell — Electron wrapper around the harness Web GUI.
 *
 * The main process spawns the dsh CLI (`web --port 0`) as a child process,
 * waits for its readiness line (`dsh web: http://127.0.0.1:<port>` — the
 * documented supervisor signal from dsh-web-app), then loads that URL in a
 * BrowserWindow. All agent/host logic stays in the child; quitting SIGTERMs it.
 *
 * Two launch modes:
 *   dev      (npm start)        — system node runs the repo's apps/cli/lib/bin.js
 *   packaged (electron-builder) — ELECTRON_RUN_AS_NODE reuses this binary as
 *                                 the Node runtime for the staged closure at
 *                                 resources/runtime/lib/bin.js
 */

import { app, BrowserWindow, Menu, Tray, ipcMain, nativeImage, nativeTheme, shell } from 'electron'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { cpSync } from 'node:fs'
import { readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const IS_PACKAGED = app.isPackaged
const DEV_ROOT = fileURLToPath(new URL('..', import.meta.url))
const RUNTIME_ROOT = IS_PACKAGED ? `${process.resourcesPath}/runtime` : DEV_ROOT
const CLI_BIN = IS_PACKAGED ? `${RUNTIME_ROOT}/lib/bin.js` : `${DEV_ROOT}apps/cli/lib/bin.js`
const BUILD_DIR = fileURLToPath(new URL('./build/', import.meta.url))
/** Patch overlay composing the custom-background plugin into the web profile. */
const BACKGROUND_OVERLAY = IS_PACKAGED
  ? `${RUNTIME_ROOT}/background-overlay.yml`
  : fileURLToPath(new URL('./background-plugin/overlay.yml', import.meta.url))
const URL_LINE = /dsh web: (https?:\/\/\S+)/

/**
 * Parse a CSS color from the page's theme-color meta into opaque RGB
 * components, or undefined when unparsable.
 */
function parseColor(color) {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.exec(color.trim())
  if (hex) {
    let value = hex[1]
    if (value.length === 3) value = [...value].map(c => c + c).join('')
    return [0, 2, 4].map(i => parseInt(value.slice(i, i + 2), 16))
  }
  const fn = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(color.trim())
  if (fn) return [Number(fn[1]), Number(fn[2]), Number(fn[3])]
  return undefined
}

/** Keep the window chrome on the page's rendered theme: frame dark mode for
 *  readable caption glyphs, plus the background color behind fresh paints. */
function applyThemeColor(color) {
  if (!win) return
  const rgb = parseColor(color)
  if (!rgb) return
  const [r, g, b] = rgb
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  // The frame's dark mode drives the system-drawn caption buttons; follow the
  // app theme (not the OS) so glyphs stay readable in every combination.
  nativeTheme.themeSource = luminance > 0.5 ? 'light' : 'dark'
  const hex = `#${rgb.map(v => v.toString(16).padStart(2, '0')).join('')}`
  win.setBackgroundColor(hex)
  writeFile(join(app.getPath('userData'), 'last-theme-color'), hex).catch(() => {})
}

/** Last reported theme color, so the next launch starts on-theme. */
function persistedThemeColor() {
  try {
    const color = readFileSync(join(app.getPath('userData'), 'last-theme-color'), 'utf8').trim()
    return parseColor(color) ? color : undefined
  } catch {
    return undefined
  }
}

/** @type {import('node:child_process').ChildProcess | null} */
let child = null
/** @type {BrowserWindow | null} */
let win = null
/** @type {Tray | null} */
let tray = null
let childExited = false
/** True only when the user chose Quit; the window close button hides to tray. */
let quitting = false
let recentOutput = ''

function loadingPage(background) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><html><body style="margin:0;display:flex;height:100vh;align-items:center;justify-content:center;'
    + `font:14px system-ui;background:${background};color:#888d94">正在启动 DeepSeek Harness…</body></html>`,
  )
}

function errorPage(detail) {
  return 'data:text/html;charset=utf-8,' + encodeURIComponent(
    '<!doctype html><html><body style="margin:0;padding:32px;font:14px system-ui;background:#1a1b1e;color:#c9cdd4">'
    + '<h3>DeepSeek Harness 启动失败</h3>'
    + '<p>开发模式请先在仓库根目录执行 <code>pnpm install &amp;&amp; pnpm run build</code>；'
    + '安装包模式请反馈安装日志。</p>'
    + `<pre style="white-space:pre-wrap;color:#8b909a">${detail.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`
    + '</body></html>',
  )
}

/**
 * Make the custom-background plugin resolvable from the web profile:
 * dev links the source package, packaged mode copies the staged build into
 * the profile's node_modules (end-user machines have no pnpm for
 * `dsh plugin add`). Idempotent; the profile package.json dep entry is only
 * amended when the file already exists (first boot lets the CLI initialize
 * the profile itself).
 */
function ensureBackgroundPlugin() {
  const source = IS_PACKAGED
    ? `${process.resourcesPath}/runtime/plugin/dsh-ui-background`
    : fileURLToPath(new URL('./background-plugin', import.meta.url))
  const dshHome = process.env.DSH_HOME ?? join(homedir(), '.dsh')
  const profileDir = join(dshHome, 'profiles', 'web')
  const destination = join(profileDir, 'node_modules', 'dsh-ui-background')
  try {
    if (!existsSync(destination)) {
      mkdirSync(join(profileDir, 'node_modules'), { recursive: true })
      if (IS_PACKAGED) {
        cpSync(source, destination, { recursive: true })
      } else {
        symlinkSync(source, destination, 'junction')
      }
    }
    const manifestPath = join(profileDir, 'package.json')
    if (existsSync(manifestPath)) {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
      const dependencies = manifest.dependencies ??= {}
      dependencies['dsh-ui-background'] ??= `file:${source.replace(/\\/g, '/')}`
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
    }
  } catch (error) {
    // The feature is additive; a failed install must not block the app.
    console.warn('[dsh-desktop] background plugin install skipped:', error)
  }
}

function startHarness() {
  if (!existsSync(CLI_BIN)) {
    recentOutput = `runtime entry missing: ${CLI_BIN}`
    win?.loadURL(errorPage(recentOutput))
    return
  }
  ensureBackgroundPlugin()
  // Packaged mode reuses the Electron binary as plain Node so the installer
  // stays self-contained (Electron 39 embeds Node 22, satisfying engines).
  const command = IS_PACKAGED ? process.execPath : (process.platform === 'win32' ? 'node.exe' : 'node')
  const env = { ...process.env }
  if (IS_PACKAGED) env.ELECTRON_RUN_AS_NODE = '1'
  // `--port 0` requests an OS-assigned loopback port; the CLI prints the
  // bound URL once every sibling row (including /api) has mounted.
  // `--expose-internals` is required by the harness's watch-only HMR service
  // (profile-boot mounts cordis-plugin-hmr on every long-lived surface).
  // --patch composes the local background plugin into the web profile.
  child = spawn(command, ['--expose-internals', CLI_BIN, 'web', '--patch', BACKGROUND_OVERLAY, '--port', '0'], {
    cwd: RUNTIME_ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  let buffer = ''
  child.stdout.on('data', (chunk) => {
    const text = String(chunk)
    recentOutput = (recentOutput + text).slice(-8000)
    buffer += text
    const match = URL_LINE.exec(buffer)
    if (match) {
      buffer = ''
      console.log(`[dsh-desktop] harness ready at ${match[1]}`)
      win?.loadURL(match[1])
    }
  })
  child.stderr.on('data', (chunk) => {
    const text = String(chunk)
    recentOutput = (recentOutput + text).slice(-8000)
    process.stderr.write(text)
  })
  child.on('exit', (code, signal) => {
    childExited = true
    console.log(`[dsh-desktop] harness exited (code=${String(code)}, signal=${String(signal)})`)
    if (!quitting && win && !win.webContents.getURL().startsWith('http')) {
      win.loadURL(errorPage(recentOutput || 'dsh 进程在输出就绪 URL 前退出。'))
    }
  })
}

function stopHarness() {
  if (child && !childExited) {
    // SIGTERM is the CLI's ordinary graceful stop (five-second drain).
    child.kill('SIGTERM')
  }
}

function createWindow() {
  // Start on the last session's theme color to avoid a wrong-theme flash;
  // the preload's first report corrects it if the setting changed.
  const initial = persistedThemeColor() ?? '#1a1b1e'
  const initialRgb = parseColor(initial)
  if (initialRgb) {
    const luminance = (0.299 * initialRgb[0] + 0.587 * initialRgb[1] + 0.114 * initialRgb[2]) / 255
    nativeTheme.themeSource = luminance > 0.5 ? 'light' : 'dark'
  }
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    title: 'DeepSeek Harness',
    icon: nativeImage.createFromPath(`${BUILD_DIR}icon.png`),
    backgroundColor: initial,
    autoHideMenuBar: true,
    // Frameless look with system-drawn window controls overlaying the page.
    // No titleBarOverlay: on Windows 11 the overlay renders as a foreign
    // rounded container over the page, while the plain hidden title bar
    // draws flush caption glyphs with no background of their own.
    titleBarStyle: 'hidden',
    webPreferences: {
      // Same posture as a plain browser tab: the GUI needs only fetch +
      // WebSocket to its loopback origin. The preload only watches the page's
      // theme-color meta to keep the window chrome in sync.
      contextIsolation: true,
      nodeIntegration: false,
      preload: fileURLToPath(new URL('./preload.cjs', import.meta.url)),
    },
  })
  win.loadURL(loadingPage(initial))
  win.webContents.setWindowOpenHandler(({ url }) => {
    // External links leave the shell; in-app navigation stays.
    if (url.startsWith('http://127.0.0.1')) return { action: 'allow' }
    void shell.openExternal(url)
    return { action: 'deny' }
  })
  win.on('close', (event) => {
    if (!quitting) {
      // Close-to-tray: the harness keeps running in the background.
      event.preventDefault()
      win?.hide()
    }
  })
  win.on('closed', () => { win = null })
  // Keep the page-drawn maximize/restore glyph in sync.
  win.on('maximize', () => { win?.webContents.send('dsh:window:state', true) })
  win.on('unmaximize', () => { win?.webContents.send('dsh:window:state', false) })
}

function createTray() {
  const icon = nativeImage.createFromPath(`${BUILD_DIR}tray.png`)
  tray = new Tray(icon)
  tray.setToolTip('DeepSeek Harness')
  tray.on('click', () => showWindow())
  rebuildTrayMenu()
}

function showWindow() {
  if (win) {
    if (win.isMinimized()) win.restore()
    win.show()
    win.focus()
  } else {
    createWindow()
  }
}

function rebuildTrayMenu() {
  const loginOpen = app.getLoginItemSettings().openAtLogin
  tray?.setContextMenu(Menu.buildFromTemplate([
    { label: '显示窗口', click: () => showWindow() },
    {
      label: '开机自动启动',
      type: 'checkbox',
      checked: loginOpen,
      click: (item) => {
        app.setLoginItemSettings({ openAtLogin: item.checked })
        rebuildTrayMenu()
      },
    },
    { type: 'separator' },
    {
      label: '退出',
      click: () => {
        quitting = true
        stopHarness()
        app.quit()
      },
    },
  ]))
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(() => {
    ipcMain.on('dsh:theme-color', (_event, color) => {
      if (typeof color === 'string') applyThemeColor(color)
    })
    // The page-drawn caption buttons (preload) drive the window through these.
    ipcMain.on('dsh:window:minimize', () => win?.minimize())
    ipcMain.on('dsh:window:maximize', () => {
      if (win) {
        if (win.isMaximized()) win.unmaximize()
        else win.maximize()
      }
    })
    ipcMain.on('dsh:window:close', () => win?.close())
    // Background-image persistence for the custom-background plugin (the
    // harness settings API's namespace allowlist is upstream-hardcoded, so the
    // shell stores the data URL itself).
    const backgroundFile = join(app.getPath('userData'), 'background-image')
    ipcMain.handle('dsh:background:get', async () => {
      try {
        return await readFile(backgroundFile, 'utf8')
      } catch {
        return ''
      }
    })
    ipcMain.handle('dsh:background:set', async (_event, image) => {
      if (typeof image !== 'string' || (image !== '' && !image.startsWith('data:image/'))) return
      if (image.length > 16 * 1024 * 1024) return
      if (image === '') await rm(backgroundFile, { force: true })
      else await writeFile(backgroundFile, image)
    })
    createWindow()
    createTray()
    startHarness()
  })
  app.on('before-quit', () => {
    quitting = true
    stopHarness()
  })
  // window-all-closed intentionally not wired to quit: the tray owns the
  // app lifetime, matching close-to-tray.
}
