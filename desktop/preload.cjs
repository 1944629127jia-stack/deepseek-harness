/**
 * Preload: two narrow bridges into the harness page, isolated from it, plus
 * the frameless-window CSS (drag strip + caption-zone clearance).
 *
 * 1. Theme/mask watcher — reads the page's `<meta name="theme-color">` (and
 *    modal-mask presence) and forwards the effective chrome color to the main
 *    process, keeping the window chrome (frame dark mode, background) in sync
 *    with theme and dialogs.
 * 2. `dshBackground` bridge (contextBridge) — persistence for the
 *    custom-background plugin: the page posts/reads the image data URL, the
 *    main process stores it under userData. Needed because the harness
 *    settings API hardcodes an upstream namespace allowlist, and loopback
 *    origins change with the OS-assigned port, so neither settings.yaml nor
 *    localStorage can persist this value for the desktop shell.
 */

const { contextBridge, ipcRenderer, webFrame } = require('electron')

// Frameless chrome support: the caption buttons are page-drawn (below), so
// the top strip doubles as the drag handle and the session header yields
// the caption zone. The header's own controls stay clickable via no-drag.
webFrame.insertCSS(`
body::before {
  content: '';
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  height: 10px;
  -webkit-app-region: drag;
  z-index: 2147483646;
}
header {
  -webkit-app-region: drag;
  padding-right: 150px !important;
}
header :is(a, button, input, textarea, select, [role="button"], [contenteditable="true"]) {
  -webkit-app-region: no-drag;
}
#dsh-caption {
  position: fixed;
  top: 0;
  right: 0;
  z-index: 2147483647;
  display: flex;
  -webkit-app-region: no-drag;
  color: #1a1b1e;
}
body[data-ds-dark-theme] #dsh-caption {
  color: #f2f3f5;
}
#dsh-caption button {
  width: 46px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  margin: 0;
  padding: 0;
  background: transparent;
  color: inherit;
  cursor: default;
}
#dsh-caption button:hover {
  background: rgba(0, 0, 0, 0.06);
}
body[data-ds-dark-theme] #dsh-caption button:hover {
  background: rgba(255, 255, 255, 0.08);
}
#dsh-caption button[data-cap="close"]:hover {
  background: #e81123;
  color: #ffffff;
}
`)

const CAPTION_ICONS = {
  minimize: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 6h10" stroke="currentColor"/></svg>',
  maximize: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor"/></svg>',
  restore: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M3.5 3.5v-2h7v7h-2M1.5 3.5h7v7h-7z" fill="none" stroke="currentColor"/></svg>',
  close: '<svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true"><path d="M1 1l10 10M11 1L1 11" stroke="currentColor"/></svg>',
}

// Page-drawn caption buttons: titleBarStyle 'hidden' on Windows paints no
// window controls of its own without the overlay (whose container is the
// foreign pill this replaces), so the shell draws its own.
window.addEventListener('DOMContentLoaded', () => {
  if (document.getElementById('dsh-caption') !== null) return
  const bar = document.createElement('div')
  bar.id = 'dsh-caption'
  const maxButton = document.createElement('button')
  maxButton.dataset.cap = 'maximize'
  maxButton.innerHTML = CAPTION_ICONS.maximize
  maxButton.addEventListener('click', () => { ipcRenderer.send('dsh:window:maximize') })
  const minButton = document.createElement('button')
  minButton.dataset.cap = 'minimize'
  minButton.innerHTML = CAPTION_ICONS.minimize
  minButton.addEventListener('click', () => { ipcRenderer.send('dsh:window:minimize') })
  const closeButton = document.createElement('button')
  closeButton.dataset.cap = 'close'
  closeButton.innerHTML = CAPTION_ICONS.close
  closeButton.addEventListener('click', () => { ipcRenderer.send('dsh:window:close') })
  bar.append(minButton, maxButton, closeButton)
  document.body.append(bar)
  ipcRenderer.on('dsh:window:state', (_event, maximized) => {
    maxButton.innerHTML = maximized ? CAPTION_ICONS.restore : CAPTION_ICONS.maximize
  })
})

contextBridge.exposeInMainWorld('dshBackground', {
  /** @returns the persisted background image data URL ('' when unset). */
  get: () => ipcRenderer.invoke('dsh:background:get'),
  /** Persist one background image data URL ('' clears). @param {string} image */
  set: (image) => ipcRenderer.invoke('dsh:background:set', image),
})

/** Parse `rgb(a)(r, g, b[, a])` into components, or undefined. */
function parseRgb(color) {
  const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(color.trim())
  if (!match) return undefined
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] === undefined ? 1 : Number(match[4]) }
}

/** A color is usable for chrome only when it parses and is not fully transparent. */
function usableColor(color) {
  if (!color || color.startsWith('#')) return color || undefined
  const parsed = parseRgb(color)
  return parsed && parsed.a > 0 ? color : undefined
}

/** Read the current theme color from the page, or undefined when unknown. */
function currentThemeColor() {
  const meta = document.head?.querySelector('meta[name="theme-color"]')
  const fromMeta = usableColor(meta?.content)
  if (fromMeta) return fromMeta
  if (document.body) return usableColor(getComputedStyle(document.body).backgroundColor)
  return undefined
}

/** Parse `rgb(a)(r, g, b[, a])` into components, or undefined. */
function parseRgb(color) {
  const match = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(color.trim())
  if (!match) return undefined
  return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] === undefined ? 1 : Number(match[4]) }
}

/**
 * Find a viewport-covering modal mask: a fixed/absolute layer with a
 * backdrop-filter. Only body-level portal roots and their immediate children
 * are inspected, so the check stays cheap under streaming DOM updates.
 * @returns the mask's computed background color, or undefined when no mask.
 */
function findMaskColor() {
  if (!document.body) return undefined
  const candidates = []
  for (const root of document.body.children) candidates.push(root, ...root.children)
  for (const element of candidates) {
    const style = getComputedStyle(element)
    if (style.backdropFilter !== 'none' && style.position !== 'static') {
      return style.backgroundColor
    }
  }
  return undefined
}

/** Blend a translucent mask color over an opaque theme color. */
function blendOver(theme, mask) {
  const t = parseRgb(theme.startsWith('#') ? hexToRgb(theme) : theme)
  const m = parseRgb(mask)
  if (!t || !m) return undefined
  const mix = channel => Math.round(m[channel] * m.a + t[channel] * (1 - m.a))
  return `rgb(${mix('r')}, ${mix('g')}, ${mix('b')})`
}

function hexToRgb(hex) {
  let value = hex.replace('#', '')
  if (value.length === 3) value = [...value].map(c => c + c).join('')
  const n = parseInt(value.slice(0, 6), 16)
  return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`
}

let lastSent
function report() {
  const theme = currentThemeColor()
  if (!theme) return
  const mask = findMaskColor()
  const color = mask ? (blendOver(theme, mask) ?? theme) : theme
  if (color !== lastSent) {
    lastSent = color
    ipcRenderer.send('dsh:theme-color', color)
  }
}

let scheduled = false
function scheduleReport() {
  if (scheduled) return
  scheduled = true
  requestAnimationFrame(() => {
    scheduled = false
    report()
  })
}

window.addEventListener('DOMContentLoaded', () => {
  report()
  // The presenter replaces the meta node on each apply, so watch head
  // children as well as the meta's own content attribute.
  new MutationObserver(scheduleReport).observe(document.head, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['content'],
  })
  // Modal masks portal under body; direct-child add/remove is the signal.
  new MutationObserver(scheduleReport).observe(document.body, { childList: true })
})
