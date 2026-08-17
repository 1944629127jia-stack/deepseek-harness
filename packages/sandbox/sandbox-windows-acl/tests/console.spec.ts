/**
 * ensureHostConsole unit tests with stub binding tables: a host with a
 * console is left untouched, a console-less host gets one allocated and
 * hidden, and an AllocConsole refusal reports false instead of throwing.
 * Pure stubs — no real Win32 calls, so these run on every platform.
 */

import { describe, expect, it, vi } from 'vitest'

import { ensureHostConsole } from '../src/console.ts'
import type { NativePtr, Win32Bindings } from '../src/ffi.ts'
import * as abi from '../src/win32-abi.ts'

describe('ensureHostConsole', () => {
  it('leaves a host that already owns a console untouched', () => {
    const allocConsole = vi.fn(() => 1)
    const api = {
      getConsoleWindow: vi.fn(() => 999n),
      allocConsole,
    } as unknown as Win32Bindings
    expect(ensureHostConsole(api)).toBe(true)
    expect(allocConsole).not.toHaveBeenCalled()
  })

  it('allocates and hides a console on a console-less host', () => {
    const window = 888n as NativePtr
    const showWindow = vi.fn(() => 1)
    const api = {
      getConsoleWindow: vi.fn()
        .mockReturnValueOnce(null) // the console-less probe
        .mockReturnValueOnce(window), // the window right after AllocConsole
      allocConsole: vi.fn(() => 1),
      showWindow,
    } as unknown as Win32Bindings
    expect(ensureHostConsole(api)).toBe(true)
    expect(showWindow).toHaveBeenCalledExactlyOnceWith(window, abi.SW_HIDE)
  })

  it('skips the hide when AllocConsole yields no window', () => {
    const showWindow = vi.fn(() => 1)
    const api = {
      getConsoleWindow: vi.fn(() => null),
      allocConsole: vi.fn(() => 1),
      showWindow,
    } as unknown as Win32Bindings
    expect(ensureHostConsole(api)).toBe(true)
    expect(showWindow).not.toHaveBeenCalled()
  })

  it('reports false when the host refuses to allocate a console', () => {
    const api = {
      getConsoleWindow: vi.fn(() => null),
      allocConsole: vi.fn(() => 0),
    } as unknown as Win32Bindings
    expect(ensureHostConsole(api)).toBe(false)
  })
})
