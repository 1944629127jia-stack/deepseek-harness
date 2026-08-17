/**
 * Build config for the out-of-tree client plugin: reuses the repo's shared
 * preset (closure-factory client bundle + ESM node half). No workspace tsc
 * project — tsdown compiles straight from src (dts off by preset).
 */
import { clientBundle } from '../../packages/client/tsdown.client.ts'

export default clientBundle('dsh-ui-background', ['src/index.ts'])
