# Agent Note: Win32 dialog worker exits report status and stderr

Status: implemented

English | [中文](2026-08-16-win32-dialog-worker-exit-diagnostics.zh.md)

## Problem

An installed desktop build failed every "Select workspace" click on one machine with `win32 folder dialog worker exited before reporting a result`: the dialog child process died before any IPC message, and the bare rejection carried nothing to diagnose with — no exit code, no signal, none of the child's output. The failure reproduced nowhere else (shell-launched, GUI-launched, Explorer-launched sessions all opened the dialog), so the only way forward was for the next occurrence to report its own cause. The most plausible killer on that machine is security software terminating the freshly installed child, but the error could not confirm or refute that.

## Decision

`spawnDialogWorker` now pipes the worker's stderr (previously inherited) and returns the child wrapped in `DialogWorkerProcess` (`win32-dialog-host.ts`), which captures up to 4 KiB of trailing stderr and forwards the child's `close` event as the driver-facing `exit` — `close`, not `exit`, because Node may fire `exit` before the stdio streams drain, which would truncate the tail exactly when it is read. The driver's exit rejection (`win32-dialog.ts`) names the status — `exit code N`, with a hex rendering when N exceeds 255 so NTSTATUS fatalities like 0xC0000005 read at a glance, or `signal SIGx` — and appends the captured stderr tail when non-empty. `Win32DialogWorkerLike` gains the two-argument exit listener and an optional `stderrTail()`; `node:child_process` still satisfies the surface. The child-process + koffi design itself is unchanged (see the [owning feature note](../feature/2026-08-02-win32-in-process-folder-dialog.md)).

## Alternatives considered

- **Automatic retry on a silent exit.** Rejected: speculative handling for an unconfirmed cause. A security-software kill repeats identically on retry and a native fault crashes again, while the instrumented error turns the next failure into actionable evidence instead.
- **Keep stderr inherited and ask affected users for console logs.** Rejected: the installed GUI has no console attached, so the child's output reaches nothing; piping is the only way it survives to be reported.
- **Forward the child's `exit` event rather than `close`.** Rejected: Node documents that `exit` can fire before the stdio streams close, so the diagnostic would race its own evidence.

## Consequences

- The next silent-exit failure reports its own cause: exit code or signal plus up to 4 KiB of worker stderr. A security-software kill shows as a fatal code (1, or 3221225477 rendered `0xc0000005`) with an empty tail; a module-load or koffi failure shows its Node stack in the tail.
- Worker stderr no longer reaches the parent's console on terminal launches; it surfaces only inside the thrown error.
- `win32-dialog.spec.ts` pins the new message shapes (code, hex code, signal, stderr, empty tail) against fakes, and the new `win32-dialog-host.spec.ts` pins forwarding, the bounded tail, and kill passthrough with real keyless child processes on every platform. Per-file 100% coverage holds for both source files.
