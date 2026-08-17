/** `settings.background` namespace dictionaries (the Background row's copy). */

/** Simplified Chinese dictionary (the key-set source of truth). */
export const zh = {
  'background.title': '自定义背景',
  'background.upload': '上传图片',
  'background.replace': '更换图片',
  'background.clear': '清除',
  'background.tooLarge': '图片不能超过 10 MB',
} satisfies Record<string, string>

/** The settings.background namespace key union. */
export type BackgroundKey = keyof typeof zh

/** English dictionary, checked complete against the zh key set. */
export const en = {
  'background.title': 'Custom background',
  'background.upload': 'Upload image',
  'background.replace': 'Replace image',
  'background.clear': 'Clear',
  'background.tooLarge': 'Image must be 10 MB or smaller',
} satisfies Record<BackgroundKey, string>
