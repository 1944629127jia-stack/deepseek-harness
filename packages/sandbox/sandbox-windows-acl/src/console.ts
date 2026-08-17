/**
 * Host-console accommodation for console-less hosts. The confined child
 * inherits the HOST'S console attachment: on a host WITH a console (the CLI
 * under a terminal) that is the verified shape; on a host WITHOUT one (the
 * packaged desktop shell, a service), every confined child whose process
 * initialization must create its own console connection dies inside
 * KernelBase's DLL_PROCESS_ATTACH with STATUS_DLL_INIT_FAILED (0xC0000142),
 * and DETACHED_PROCESS is no substitute — a detached PowerShell starts but
 * exits vacuously without running its command (both verified end-to-end
 * against the packaged desktop shell; see win32-abi.ts). The long-lived host
 * therefore allocates ONE console for itself and hides it, so every runner
 * and confined child it ever spawns inherits a working attachment. The
 * per-command runner completes the chain from the other side: in the
 * packaged shell it runs as a GUI-subsystem Electron image, which never
 * inherits the host's console automatically, so it attaches to the parent
 * console explicitly ({@link attachParentConsole}).
 * @module @deepseek-ai/dsh-sandbox-windows-acl/console
 */

import { isNullPtr, win32Sync } from './ffi.ts'
import type { Win32Bindings } from './ffi.ts'
import * as abi from './win32-abi.ts'

/**
 * Ensure this process owns a console, allocating and immediately hiding one
 * (SW_HIDE) when the process has none. Idempotent and cheap after the first
 * call: a host that already has a console returns without touching it. One
 * hidden console per host process lifetime; every runner and confined child
 * spawned afterwards inherits the attachment. Call it from the LONG-LIVED
 * host (the sandbox provider's process), never from the per-command runner —
 * a console dies with its last attached process, so a per-command allocation
 * would flash a window per command.
 * @param api - the binding table (defaults to the shared real bindings so
 *   long-lived hosts can call it bare).
 * @returns true when this process owns a console after the call; false when
 *   the host refused to allocate one (the confined spawn then runs without
 *   the accommodation and a console-less host keeps its pre-existing
 *   behavior).
 */
export function ensureHostConsole(api: Win32Bindings = win32Sync()): boolean {
  if (!isNullPtr(api.getConsoleWindow())) return true
  if (api.allocConsole() === 0) return false
  const window = api.getConsoleWindow()
  if (!isNullPtr(window)) api.showWindow(window, abi.SW_HIDE) // best-effort hide; the attachment matters, not the visibility
  return true
}

/**
 * Attach this process to its parent's console when it has none. The runner's
 * half of the console-less-host accommodation: a console-subsystem image
 * (plain node) inherits the host console at creation, but a GUI-subsystem
 * image (the packaged desktop shell's Electron binary running the runner)
 * never does — without this attachment the confined child would again face
 * process initialization with no console to inherit and die with
 * STATUS_DLL_INIT_FAILED. Best-effort like the host half: a false return
 * means the parent had no console to attach to (a host that refused the
 * accommodation), and the confined spawn keeps its pre-existing behavior.
 * No AllocConsole fallback here — a per-command console would flash a window
 * per command and die with the runner.
 * @param api - the binding table (defaults to the shared real bindings).
 * @returns true when this process owns or has attached to a console after
 *   the call; false when there was no parent console to attach to.
 */
export function attachParentConsole(api: Win32Bindings = win32Sync()): boolean {
  if (!isNullPtr(api.getConsoleWindow())) return true
  return api.attachConsole(abi.ATTACH_PARENT_PROCESS) !== 0
}
