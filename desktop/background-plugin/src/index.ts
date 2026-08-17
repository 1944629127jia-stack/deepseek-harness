/**
 * Host half of the custom-background plugin. Deliberately empty: the feature
 * needs no Host services — the image persists through the desktop shell's
 * preload bridge (see desktop/preload.cjs), because the harness settings API
 * exposes only an upstream-hardcoded namespace allowlist. The package still
 * needs this entry so the composition row resolves and boots it.
 */

import type { Context } from '@deepseek-ai/cordis'

/** Stable Cordis plugin name. */
export const name = 'ui-background'

/**
 * No-op Host body.
 * @param _ctx - Host context (unused).
 */
export function apply(_ctx: Context): void {}
