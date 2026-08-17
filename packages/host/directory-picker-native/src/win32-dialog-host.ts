/**
 * Real-process half of the Win32 dialog driver: spawn the dialog child
 * process (source or built plane) and close a dialog thread's windows. The
 * module itself loads everywhere (the import chain from native-picker.ts is
 * static); what stays win32-only is koffi, imported dynamically inside the
 * bindings' functions. The driver's logic is tested against fakes of this
 * surface instead.
 */

import { spawn, type ChildProcess, type StdioOptions } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { fileURLToPath } from 'node:url'
import type { Win32DialogWorkerLike } from './win32-dialog.ts'
import type { Win32DialogWorkerData, Win32DialogWorkerMessage } from './win32-dialog-worker.ts'

/** Bytes of worker stderr kept for the exit diagnostic. */
const STDERR_TAIL_BYTES = 4096

/** A spawned dialog worker with the stderr tail its exit diagnostic reports. */
export type SpawnedDialogWorker = Win32DialogWorkerLike & { stderrTail(): string }

/** EventEmitter adapter over a spawned dialog child. */
class DialogWorkerProcess extends EventEmitter implements SpawnedDialogWorker {
  private tail = Buffer.alloc(0)

  constructor(private readonly child: ChildProcess) {
    super()
    child.on('message', (message: Win32DialogWorkerMessage) => {
      this.emit('message', message)
    })
    child.on('error', (error: Error) => {
      this.emit('error', error)
    })
    // Forward from `close`, not `exit`: `exit` may fire before the stdio
    // streams drain, which would truncate the tail the driver reads while
    // assembling its exit diagnostic; `close` fires once stderr is received.
    child.on('close', (code: number | null, signal: NodeJS.Signals | null) => {
      this.emit('exit', code, signal)
    })
    const stderr = child.stderr
    if (stderr !== null) {
      stderr.on('data', (chunk: Buffer) => {
        this.tail = Buffer.concat([this.tail, chunk]).subarray(-STDERR_TAIL_BYTES)
      })
    }
  }

  kill(): boolean {
    return this.child.kill()
  }

  unref(): void {
    this.child.unref()
  }

  stderrTail(): string {
    return this.tail.toString('utf8').trim()
  }
}

/**
 * Wrap a spawned dialog child with the driver-facing surface: message, error,
 * and exit forwarding, plus the captured stderr tail. Exit is forwarded from
 * the child's `close` event so the tail is complete when the driver reads it.
 * @param child - the spawned dialog worker process.
 * @returns the child process adapted for `pickWin32Directory`.
 */
export function wrapDialogWorker(child: ChildProcess): SpawnedDialogWorker {
  return new DialogWorkerProcess(child)
}

/**
 * Spawn the dialog child process. Built consumers launch the bundled CJS
 * entry next to this module under plain node; unbuilt (source) consumers
 * bootstrap tsx first, mirroring the dsh CLI's source launch. The dialog is
 * the child's first window, so Windows activates it without a foreground
 * call. The worker's stderr is captured (not inherited) so an exit without
 * an IPC result - module-load crash, native fault, external kill - reports
 * the child's last output in the thrown error.
 * @param data - the child payload (dialog title).
 * @returns the spawned child process adapted for the driver.
 */
export function spawnDialogWorker(data: Win32DialogWorkerData): SpawnedDialogWorker {
  const env = { ...process.env, DSH_DIALOG_TITLE: data.title }
  const stdio: StdioOptions = ['ignore', 'inherit', 'pipe', 'ipc']
  /* v8 ignore next 3 -- the built-output arm: tests always run unbuilt (src/) */
  if (!import.meta.url.endsWith('.ts')) {
    return wrapDialogWorker(spawn(process.execPath, [fileURLToPath(new URL('./worker.cjs', import.meta.url))], { env, stdio, windowsHide: true }))
  }
  return wrapDialogWorker(spawn(process.execPath, ['--import', import.meta.resolve('tsx/esm'), fileURLToPath(new URL('./win32-dialog-worker.ts', import.meta.url))], { env, stdio, windowsHide: true }))
}

export { closeThreadWindows } from './win32-dialog-bindings.ts'
