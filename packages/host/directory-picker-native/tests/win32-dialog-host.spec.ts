/**
 * Host-wrapper tests: the spawned-child adapter the driver drives - message,
 * error, and exit forwarding (exit from `close`, after stderr drains), the
 * bounded stderr capture, and kill passthrough. Real child processes keep
 * these keyless on every platform.
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { describe, expect, it } from 'vitest'
import { wrapDialogWorker } from '../src/win32-dialog-host.ts'
import type { Win32DialogWorkerMessage } from '../src/win32-dialog-worker.ts'

describe('wrapDialogWorker', () => {
  it('forwards ipc messages and process errors', () => {
    const child = Object.assign(new EventEmitter(), { stderr: new EventEmitter() }) as unknown as ChildProcess
    const worker = wrapDialogWorker(child)
    const received: Win32DialogWorkerMessage[] = []
    worker.on('message', (message) => {
      received.push(message)
    })
    const failures: Error[] = []
    worker.on('error', (error) => {
      failures.push(error)
    })
    const notice: Win32DialogWorkerMessage = { kind: 'showing', threadId: 7 }
    child.emit('message', notice)
    child.emit('error', new Error('spawn failed'))
    expect(received).toEqual([notice])
    expect(failures.map(error => error.message)).toEqual(['spawn failed'])
  })

  it('drops the oldest stderr chunks beyond the tail budget', () => {
    const stderr = new EventEmitter()
    const child = Object.assign(new EventEmitter(), { stderr }) as unknown as ChildProcess
    const worker = wrapDialogWorker(child)
    stderr.emit('data', Buffer.from('old'))
    stderr.emit('data', Buffer.from('x'.repeat(5000)))
    expect(worker.stderrTail()).toBe('x'.repeat(4096))
  })

  it('reports the close status and the captured stderr tail', async () => {
    const child = spawn(process.execPath, ['-e', "console.error('boom'); process.exit(3)"], { stdio: ['ignore', 'inherit', 'pipe', 'ipc'], windowsHide: true })
    const worker = wrapDialogWorker(child)
    const exits: Array<[number | null, NodeJS.Signals | null]> = []
    worker.on('exit', (code, signal) => {
      exits.push([code, signal])
    })
    await new Promise<void>((resolve) => {
      worker.on('exit', () => {
        resolve()
      })
    })
    expect(exits).toEqual([[3, null]])
    expect(worker.stderrTail()).toBe('boom')
  }, 30_000)

  it('passes kill through and tolerates a child without piped stderr', async () => {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'], windowsHide: true })
    const worker = wrapDialogWorker(child)
    const closed = new Promise<void>((resolve) => {
      worker.on('exit', () => {
        resolve()
      })
    })
    expect(worker.kill()).toBe(true)
    await closed
    expect(worker.stderrTail()).toBe('')
  }, 30_000)
})
