/**
 * Browser half of the custom-background feature: applies the persisted image
 * onto the theme token seam — the image rides `--dsw-alias-bg-base` (every
 * shell surface consumes it through the `background` shorthand), stacked as
 * an override layer so the active theme keeps working underneath and
 * light/dark each get a readability scrim. Registers the Background
 * preference row into the settings General section.
 *
 * Persistence goes through the desktop shell's `window.dshBackground` bridge
 * (preload contextBridge → userData file): the harness settings API exposes
 * only an upstream-hardcoded namespace allowlist, and the loopback origin
 * changes with the OS-assigned port, so neither settings.yaml nor
 * localStorage can hold this value in the desktop shell. Without the bridge
 * (plain browser) the row still applies images, just for the session.
 */
import type { BoundActions } from '@deepseek-ai/dsh-client-ui-slots'
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
// Type-only: the ctx.locale / ctx.theme Context merges. Cross-plugin
// collaboration goes through services, never value imports (bundle purity).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { BackgroundRow, type BackgroundRowInjected } from './BackgroundRow.tsx'
import { createBackgroundRowStore } from './store.ts'
import { en, zh, type BackgroundKey } from './locales.ts'

export type { BackgroundRowComponentProps, BackgroundRowInjected } from './BackgroundRow.tsx'
export type { BackgroundRowState } from './store.ts'
export type { BackgroundKey } from './locales.ts'

/** Namespace owning this feature's settings-row copy. */
export const SETTINGS_NS = 'settings.background'

/** Override-layer source id handed to the theme service. */
const OVERRIDE_SOURCE = 'dsh-ui-background'

/** The desktop shell's preload bridge (absent in a plain browser). */
interface BackgroundBridge {
  get: () => Promise<string>
  set: (image: string) => Promise<void>
}

declare global {
  interface Window {
    dshBackground?: BackgroundBridge
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** The Background settings row's copy. */
    'settings.background': BackgroundKey
  }
}

/**
 * Required services: slots/locale for the row, theme for the token seam.
 */
export const inject = ['slots', 'locale', 'theme']

/** Build the per-scheme base-surface token value: readability scrim over the image, cover-fit.
 *  The trailing background-color keeps the presenter's theme-color meta (computed
 *  backgroundColor) meaningful, so the desktop shell's caption strip follows the
 *  image's perceived tone instead of stalling on transparent. */
function backgroundToken(image: string): { light: string; dark: string } {
  const layer = `url("${image}") center / cover no-repeat`
  return {
    light: `linear-gradient(rgba(250, 250, 251, 0.78), rgba(250, 250, 251, 0.78)), ${layer} rgb(250, 250, 251)`,
    dark: `linear-gradient(rgba(20, 20, 22, 0.72), rgba(20, 20, 22, 0.72)), ${layer} rgb(20, 20, 22)`,
  }
}

/**
 * Client plugin body: apply the persisted image and register the row.
 * @param ctx - client cordis context.
 */
export function apply(ctx: ClientContext): void {
  const bridge = window.dshBackground
  const store = createBackgroundRowStore()
  let bound: BoundActions<typeof store> | undefined
  let retract: (() => void) | undefined
  let currentImage = ''
  let revision = 0

  const applyImage = (image: string): void => {
    currentImage = image
    if (retract !== undefined) {
      retract()
      retract = undefined
    }
    if (image !== '') retract = ctx.theme.overrideTokens(OVERRIDE_SOURCE, { '--dsw-alias-bg-base': backgroundToken(image) })
    revision += 1
    bound?.sync(image, revision)
  }

  if (bridge !== undefined) void bridge.get().then(image => { applyImage(image) })

  ctx.effect(() => () => retract?.(), 'ui-background: retract token override on unload')
  ctx.effect(() => ctx.locale.register(SETTINGS_NS, { zh, en }), 'ui-background: settings row dictionaries')

  const injected = (actions: BoundActions<typeof store>): BackgroundRowInjected => {
    bound = actions
    // Re-sync from the tracked value so the boot-time apply is not lost when
    // it landed before the row mounted.
    bound.sync(currentImage, revision)
    return {
      upload: (dataUrl) => {
        applyImage(dataUrl)
        void bridge?.set(dataUrl)
      },
      clear: () => {
        applyImage('')
        void bridge?.set('')
      },
    }
  }
  ctx.slots.inject('settings.general.item', () => ctx.slots.register({
    name: 'settings.general.item',
    id: 'background',
    order: 11,
    store,
    locale: SETTINGS_NS,
    inject: injected,
  }, BackgroundRow))
}
