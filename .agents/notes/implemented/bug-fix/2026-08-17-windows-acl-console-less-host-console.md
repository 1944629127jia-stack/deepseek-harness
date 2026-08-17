# Agent Note: The windows-acl backend requires a console on console-less hosts

Status: implemented

English | [中文](2026-08-17-windows-acl-console-less-host-console.zh.md)

## Problem

In the packaged desktop shell (Electron GUI — no console anywhere in its process tree), every confined shell command died with exit code 3221225794 (`0xC0000142`, `STATUS_DLL_INIT_FAILED`) and zero output; the same command unconfined (`danger-full-access`) ran fine. Every standalone replay of the failing chain — same binary, same runner argv, same workspace, same SID pair, same environment block, same piped stdio shape, an identical parent-token group list — succeeded outside the live app, so the trigger was pinned down inside the app's own process context by instrumenting the installed runner as a debug loop. Loader-snaps output from the dying child showed process initialization failing inside KernelBase's `DLL_PROCESS_ATTACH` after only ntdll/kernel32/KernelBase had mapped. A creation-flag probe matrix then run inside the app's runtime settled the shape: every console-touching variant (no flags, `CREATE_NO_WINDOW`, `CREATE_NEW_CONSOLE`) died with `0xC0000142`; `DETACHED_PROCESS` started but PowerShell exited vacuously (no command run, exit 0, no output — a false positive); and a runner that first allocated a console for itself produced a confined child that attached and ran with real output. The restriction scheme's verified design — children share the host console ([design note](../feature/2026-08-08-windows-acl-restricted-token-sandbox.md)) — silently assumed the host has one; the desktop shell is the first console-less host.

## Decision

The seam gives a console-less host ONE hidden console for its lifetime. `ensureHostConsole` (`sandbox-windows-acl/src/console.ts`) allocates a console only when the process has none (`GetConsoleWindow`) and immediately hides it (`ShowWindow` `SW_HIDE`); `dsh-sandbox-local` applies it before every windows-acl wrap (`windowsAclRunnerArgv`), win32-only and injectable as `internals.ensureConsole` for tests. Confined children then inherit the host's console attachment — exactly the shape the CLI verification pins. The accommodation is best-effort by design: an `AllocConsole` refusal leaves the pre-existing behavior rather than breaking hosts where the no-console path happens to work, because the failure is not universal to console-less hosts. Coverage: `console.spec.ts` pins all four `ensureHostConsole` branches against stub bindings; `sandbox-local`'s `local.spec.ts` pins that every windows-acl wrap applies the hook; a runner e2e reproduces the console-less host from any terminal (a wrapper entry calls `FreeConsole` before loading the runner, then applies the accommodation) and asserts the confined PowerShell both survives AND emits real output — the assertion that rules out the vacuous-`DETACHED_PROCESS` false positive.

## Alternatives considered

- **`DETACHED_PROCESS` children on console-less hosts.** Rejected: the child starts but CUI tools run no command (PowerShell exits 0 with no output), verified in the desktop shell and in a local harness — an exit-0 silent no-op, strictly worse than a loud failure.
- **`CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE`.** Already documented as dying under the restriction; re-verified dying in the desktop shell's probe matrix.
- **Allocating the console inside the per-command runner.** Rejected: a console dies with its last attached process, so a per-command allocation would flash a console window per command; the console must belong to the long-lived provider process, whose attachment every runner and confined child inherits.
- **Fixing the console-creation failure itself.** Out of reach: the failure sits inside KernelBase's console initialization under `WRITE_RESTRICTED` on this host shape, and the POC's documented SID attempts (`S-1-2-1`) already failed; inheriting an existing console is the verified working path.

## Consequences

- Packaged desktop shell: confined pwsh commands run with real output; one hidden console (one conhost.exe) per runtime lifetime, established at the first confined wrap.
- Non-Windows platforms untouched (the call is win32-gated); hosts that already own a console take a no-op fast path.
- `win32-abi.ts`'s console notes and both package READMEs now state the host-console requirement; the design note's console clause cross-links this note.
