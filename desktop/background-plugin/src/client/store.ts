/**
 * Background row slot store: a mirror of the settings-scope snapshot. The
 * plugin's apply-world subscription is the only writer; the row component
 * reads via props.useStore.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-runtime/client'

/** Store state mirrored from the settings scope. */
export interface BackgroundRowState {
  /** Current background image data URL; empty string when unset. */
  image: string
  /** Scope revision; -1 until first sync so any landed value reads as a change. */
  revision: number
}

/** Declared action shape giving the exported factory a stable return type. */
type BackgroundRowActions = {
  sync: (draft: BackgroundRowState, image: string, revision: number) => void
}

/**
 * Declare the Background row state and write surface.
 * @returns the store handle.
 */
export function createBackgroundRowStore(): EngineStoreHandle<BackgroundRowState, BackgroundRowActions> {
  return defineStore({
    init: (): BackgroundRowState => ({ image: '', revision: -1 }),
    actions: {
      sync: (d, image: string, revision: number) => {
        if (revision <= d.revision && image === d.image) return
        d.image = image
        d.revision = revision
      },
    },
  })
}
