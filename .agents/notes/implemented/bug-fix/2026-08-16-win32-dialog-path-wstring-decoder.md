# Agent Note: Win32 dialog reads the selected path through koffi's wstring decoder

Status: implemented

English | [中文](2026-08-16-win32-dialog-path-wstring-decoder.zh.md)

## Problem

Every completed folder selection in the packaged desktop build crashed the dialog worker with `FATAL ERROR: Error::New napi_get_last_error_info` (exit code 134), surfaced as `win32 folder dialog worker exited before reporting a result` — the dialog opened, the user picked a folder, and the worker died reading the selected path back. `readUtf16` in `win32-dialog-bindings.ts` viewed the `IShellItem::GetDisplayName` pointer through `koffi.view(addr, 32768)`, which aborts the process under the packaged runtime (Electron 39's embedded Node 22, reused as plain Node per the desktop shell): koffi's N-API error path fatals instead of throwing. The open-and-abort smoke never exercises the selection path, so no automated test saw it; the [exit diagnostics](../bug-fix/2026-08-16-win32-dialog-worker-exit-diagnostics.md) shipped in the same window are what made the failing frame (`readUtf16`, `resultPath`) visible from a user report. The root cause was first identified publicly in [discussion #30](https://github.com/deepseek-ai/deepseek-harness/discussions/30) (koffi-version-independent, runtime-dependent).

## Decision

`readUtf16` now reads through `koffi.decode.wstring(address)` (koffi 3.1+, already the pinned dependency), and the `Koffi` interface types `decode` accordingly and drops `view`. The `_Out_ void **` out-param stays as-is: `koffi.decode(addr, 'str16')` remains wrong here (it would dereference the address as a pointer). The fix is verified against the real failure mode, not just unit fakes: a throwaway probe driving `SHCreateItemFromParsingName` + `IShellItem::GetDisplayName` reproduced the exact fatal under Electron's embedded Node 22 with the old `view` read, and `decode.wstring` returned the right path on that runtime and on Node 24. The mocked-koffi bindings spec provides `decode.wstring` and drops its `view` stand-in.

## Alternatives considered

- **Keep `view` and pin or patch koffi.** Rejected: the abort is runtime-dependent, not koffi-version-dependent (reproduced on 3.1.1 and reported on 3.1.5), so no koffi pin helps; patching vendored native code buys maintenance for a read the library already exposes safely.
- **Read the string with a manual `koffi.decode` loop per `uint16_t`.** Rejected: per-element decode calls for up to 32 KiB of path are slower and more code than the dedicated decoder, with no portability gain — `wstring` is the same operation done inside the addon.
- **Restrict the repo's `engines` range to exclude the affected runtime.** Rejected as the fix for this defect: the picker is the broken component, and with `decode.wstring` verified on both supported runtimes there is no residual gap to fence off.

## Consequences

- Folder selection completes in the packaged desktop build; the worker reports `{kind:'done', path}` instead of dying in `readUtf16`.
- The `Koffi` interface no longer declares `view`, so a future reader cannot reintroduce the crashing call against this typed surface without re-adding it deliberately.
- The selection path remains manually verified on real Windows (the smoke only opens and abort-closes); the mocked-COM spec pins the extraction sequencing including the wstring read, and per-file 100% coverage holds.
