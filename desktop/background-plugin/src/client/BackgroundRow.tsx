/**
 * Background preference row registered into the settings General section item
 * slot: title + optional preview + upload/clear buttons. The plugin owns its
 * settings surface; the write path goes through the injected face.
 */
import { useRef } from 'react'
import type { PropsLocale, PropsRuntime, PropsStore } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { createBackgroundRowStore } from './store.ts'
import type { BackgroundKey } from './locales.ts'
import css from './BackgroundRow.module.css'

/** Injected business face: the two preference writes (t rides the standard locale seat). */
export interface BackgroundRowInjected {
  /** Persist one picked image (data URL) as the background. */
  upload: (dataUrl: string) => void
  /** Remove the custom background. */
  clear: () => void
}

/** Full component props: runtime share + store share + locale seat + injected face. */
export type BackgroundRowComponentProps =
  PropsRuntime<'settings.general.item'> & PropsStore<ReturnType<typeof createBackgroundRowStore>>
  & PropsLocale<'settings.background'> & BackgroundRowInjected

/** Picked-file ceiling: the image persists as a data URL inside settings.yaml. */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024

/**
 * Render the Background row.
 * @param props - composed slot props.
 * @returns the row element tree.
 */
export function BackgroundRow({ t, useStore, upload, clear }: BackgroundRowComponentProps) {
  const image = useStore(s => s.image)
  const hasImage = image !== ''
  const inputRef = useRef<HTMLInputElement>(null)
  const errorRef = useRef<HTMLSpanElement>(null)

  const onPick = (files: FileList | null): void => {
    const file = files?.[0]
    if (!file) return
    if (file.size > MAX_IMAGE_BYTES) {
      if (errorRef.current) errorRef.current.textContent = t('background.tooLarge')
      return
    }
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === 'string') upload(reader.result)
    }
    reader.readAsDataURL(file)
  }

  return (
    <div className={css.group}>
      <div className={css.title}>{t('background.title')}</div>
      <div className={css.row}>
        {hasImage && <div className={css.preview} style={{ backgroundImage: `url("${image}")` }} />}
        <button type="button" className={css.button} onClick={() => inputRef.current?.click()}>
          {t(hasImage ? 'background.replace' : 'background.upload')}
        </button>
        {hasImage && (
          <button type="button" className={css.button} onClick={clear}>
            {t('background.clear')}
          </button>
        )}
        <span ref={errorRef} className={css.error} />
      </div>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        style={{ display: 'none' }}
        onChange={(event) => {
          onPick(event.currentTarget.files)
          event.currentTarget.value = ''
        }}
      />
    </div>
  )
}
