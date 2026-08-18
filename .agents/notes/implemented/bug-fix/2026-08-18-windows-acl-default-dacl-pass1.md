# Agent Note: The windows-acl default DACL must cover pass-1, not only pass-2

Status: implemented

English | [中文](2026-08-18-windows-acl-default-dacl-pass1.zh.md)

## Problem

In the packaged desktop shell, every confined command that itself spawns a child with captured output died: MSBuild's Csc task reported `error MSB3883: 意外的异常` + `拒绝访问` (`ERROR_ACCESS_DENIED`) the moment it launched `csc.exe`, while plain commands and the same builds run unconfined succeeded. Live probing pinned the failure to one syscall: `CreatePipe` (anonymous pipe creation) inside the confined process returned `ERROR_ACCESS_DENIED` — named-pipe creation and opens, unredirected spawns, workspace/temp writes all worked. The same confined chain replayed from a terminal (same runner binary, same SID pair, same workspace, same seam temp) succeeded, so the trigger was host-ancestry-dependent.

The mechanism: the runner merges a full-access ACE for a restricting SID (the private temp capability SID under workspace-write) into the restricted token's default DACL so that new-object creation passes the WRITE_RESTRICTED pass-2 check. But capability SIDs are restricting SIDs, not token GROUPS, so they can never satisfy the pass-1 (normal DACL) check. Whether pass-1 grants the creator write depends on the HOST token's inherited default DACL: a terminal-launched host carries `LA GA` (an enabled group), while the desktop shell's Explorer-launched token carries only the logon SID with `GX|GR` (Administrators is deny-only under the LUA flag) — so under the desktop shell every anonymous-pipe creation inside the confined child failed pass-1 with `ERROR_ACCESS_DENIED`, and .NET Framework's `ProcessStartInfo` redirection (which uses `CreatePipe`) took down `csc.exe` launches with it. Verified by token dumps from both chains (default DACLs differed exactly in the `LA GA` vs logon-`GX|GR` ACE) and by an explicit-SD ladder: `CreatePipe` with an explicit `Everyone FA` descriptor succeeded in the app while every default-DACL variant failed.

## Decision

Merge an Everyone full-access ACE into the restricted token's default DACL in BOTH modes, in addition to the capability-SID ACE under workspace-write (`AclSandbox.init`). Everyone is both an enabled token group (satisfies pass-1) and a required restricting SID (satisfies pass-2), so new-object creation works on every host ancestry; read-only already granted Everyone and was never broken. The default DACL only lands on inheritance-less objects (anonymous pipes, events, mutexes) — workspace and temp files inherit their parent directory DACLs — so the documented temp-tree capability isolation is unchanged, and named pipes still take the Win32 template (the piped-capture boundary stands, pinned by the unchanged runner e2e). A runner e2e (`runner.spec.ts` + `tests/fixtures/print-default-dacl.cjs`) asserts the confined token's default DACL carries the Everyone ACE in both modes.

## Alternatives considered

- **Granting only the capability SID and documenting .NET Framework redirection as unsupported.** Rejected: MSBuild/`dotnet build` tool spawns are exactly that path, and "cannot compile under the sandbox" is not a viable boundary for a coding agent.
- **Letting the confined process patch its own token at runtime.** Impossible, verified empirically: `OpenProcessToken(TOKEN_ADJUST_DEFAULT)` inside the confined child is itself denied — the grant must happen at token creation in the runner.
- **Replacing the capability-SID ACE with Everyone.** Rejected as gratuitous churn: the capability ACE documents and preserves the per-session temp isolation intent; the Everyone ACE only adds the missing pass-1 coverage.

## Consequences

- Packaged desktop shell: confined `dotnet build` (MSBuild Csc tool spawn) and .NET Framework `Process.Start` redirection work; one extra ACE in the default DACL of every restricted token.
- Named sync objects a confined process creates without an explicit descriptor become Everyone-full-access; unnamed objects (anonymous pipes) stay handle-scoped. Read-only mode already had exactly this shape.
- Hosts that never hit the gap (terminal-launched) gain one redundant-but-harmless ACE.
