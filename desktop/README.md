# dsh-desktop-shell (experimental)

Electron wrapper around the DeepSeek Harness Web GUI: the main process spawns the dsh CLI (`web --port 0`) as a child, waits for its readiness line (`dsh web: http://127.0.0.1:<port>`), and loads that URL in a `BrowserWindow`. Quitting from the tray SIGTERMs the child (the CLI's graceful stop).

This directory is deliberately standalone — it is **not** part of the pnpm workspace and has its own `node_modules`, so repo gates and the harness build are unaffected.

## Features

- **Close to tray**: the window's close button hides to the system tray; the harness keeps running. Quit from the tray menu to stop it.
- **开机自动启动**: tray checkbox backed by `app.setLoginItemSettings`.
- **Frameless window**: `titleBarStyle: 'hidden'` + `titleBarOverlay`; the preload keeps the strip's color on the page's `theme-color` meta and dims it while a modal mask is up.
- **Custom background** (Settings → 自定义背景): `background-plugin/` is an out-of-tree harness client plugin composed via `--patch background-overlay.yml`; the image rides the `--dsw-alias-bg-base` theme token through `ctx.theme.overrideTokens` (light/dark scrims included). Persistence goes through the preload's `dshBackground` contextBridge into userData, because the harness settings API hardcodes an upstream namespace allowlist and the loopback origin changes per boot. Packaged mode installs the plugin by copying the staged build into the profile's node_modules on launch.
- **Single instance**: a second launch focuses the existing window.
- External links open in the system browser; only loopback navigation stays in the shell.

## Develop

```sh
# in the repository root
pnpm install && pnpm run build

cd desktop
npm install
npm start        # dev mode: system node runs the repo's apps/cli/lib/bin.js
```

For actual agent conversations you need `DEEPSEEK_API_KEY` (root `.env` or environment), same as `dsh web`.

## Build the installer

```sh
cd desktop
npm run dist     # = stage-runtime + smoke-runtime + electron-builder
```

- `scripts/stage-runtime.mjs` walks the installed workspace from `@deepseek-ai/dsh` with Node resolution and copies the full dependency closure — dereferenced, nested on version conflicts — into `desktop/runtime/`. (pnpm's legacy deploy was rejected: it silently drops transitive workspace packages and mutated workspace links during testing.)
- `scripts/smoke-runtime.mjs` then boots the staged runtime through Electron's embedded Node (the packaged launch path) and refuses to package unless the GUI answers HTTP 200 with its boot manifest — a broken tree never reaches the installer.
- The packaged app spawns the staged `runtime/lib/bin.js` with `ELECTRON_RUN_AS_NODE=1`, reusing the Electron binary as the Node runtime, so the installer is self-contained (no system Node required).
- Output lands in `desktop/release/`. First build downloads NSIS/winCodeSign; if GitHub is unreachable, set `ELECTRON_BUILDER_BINARIES_MIRROR=https://npmmirror.com/mirrors/electron-builder-binaries/`.

`npm run icons` regenerates `build/icon.png|ico` + `build/tray.png` (zero-dependency generator — replace with real artwork when available).

## Updating with upstream

This checkout is a git clone (converted from a zip extract). `origin` is the canonical GitHub URL and pulls go through the local VPN; if GitHub is ever unreachable, `git remote set-url origin https://ghfast.top/https://github.com/deepseek-ai/deepseek-harness.git` switches to a mirror. To refresh and repackage:

```sh
git pull                   # tracked tree only — desktop/ is untracked and untouched
pnpm install && pnpm run build

cd desktop
npm run dist
```

Alternative release channel: the harness also publishes `@deepseek-ai/dsh` to npm (reachable without a mirror), so `npm view @deepseek-ai/dsh version` tells you whether master has cut a new release worth pulling.

`npm run dist` re-stages the runtime from the new build (dependency changes are picked up automatically by the closure walk) and syncs the installer version from `apps/cli/package.json`, so the artifact becomes `DeepSeek Harness Setup <harness-version>.exe`. NSIS upgrades in place: installing a newer build over an older one replaces it (same `appId`), and user data under `$DSH_HOME` is untouched.

If a refresh breaks the shell, the coupling points with upstream are exactly these — check them first:

- the stdout readiness line `dsh web: <url>` (parsed in `main.mjs`) and the `--port` flag
- the `--expose-internals` requirement of the boot composition
- the built entry `apps/cli/lib/bin.js` and `@deepseek-ai/dsh-web-frontend/dist/index.html` (both asserted by `stage-runtime.mjs`, which fails loudly)

Electron itself upgrades independently: bump `electron` / `electron-builder` in this package.json and reinstall. `ELECTRON_RUN_AS_NODE` requires Electron's embedded Node to satisfy the harness `engines` range (`^22.19 || >=24`) — check that when bumping either side.
