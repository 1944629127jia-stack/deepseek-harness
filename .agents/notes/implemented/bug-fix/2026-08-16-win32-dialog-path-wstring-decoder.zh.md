# Agent Note: Win32 dialog reads the selected path through koffi's wstring decoder

Status: implemented

[English](2026-08-16-win32-dialog-path-wstring-decoder.md) | 中文

## Problem

安装版桌面端里，每完成一次文件夹选择，对话框 worker 都以 `FATAL ERROR: Error::New napi_get_last_error_info`（退出码 134）崩溃，对外表现为 `win32 folder dialog worker exited before reporting a result`——对话框能弹出、用户能选目录，但 worker 在读回所选路径时死掉。`win32-dialog-bindings.ts` 的 `readUtf16` 用 `koffi.view(addr, 32768)` 查看 `IShellItem::GetDisplayName` 返回的指针，该调用在打包运行时（Electron 39 内嵌的 Node 22，桌面壳把它当普通 Node 复用）下直接让进程 abort：koffi 的 N-API 报错路径 fatal 了而不是抛出 JS 异常。自动测试里的"打开并中止"冒烟从不走选择路径，所以没有任何测试看到过这个崩溃；同一窗口期合入的[退出诊断插桩](../bug-fix/2026-08-16-win32-dialog-worker-exit-diagnostics.md)正是让故障帧（`readUtf16`、`resultPath`）从用户回报中可见的关键。根因最早在[讨论 #30](https://github.com/deepseek-ai/deepseek-harness/discussions/30) 中被公开定位（与 koffi 版本无关，与运行时相关）。

## Decision

`readUtf16` 改为通过 `koffi.decode.wstring(address)` 读取（koffi 3.1+ 引入，本就是锁定的依赖版本），`Koffi` 接口相应地为 `decode` 定型并移除 `view`。`_Out_ void **` 出参保持不变：`koffi.decode(addr, 'str16')` 在这里依然是错的（它会把地址当指针再解引用一次）。修复是针对真实故障模式验证过的，而非只过单元 fake：一个一次性探针用 `SHCreateItemFromParsingName` + `IShellItem::GetDisplayName` 在 Electron 内嵌 Node 22 下用旧的 `view` 读法复现了分毫不差的 fatal，而 `decode.wstring` 在该运行时和 Node 24 上都返回了正确路径。mocked-koffi 绑定测试相应提供 `decode.wstring` 并移除 `view` 替身。

## Alternatives considered

- **保留 `view`，对 koffi 锁版本或打补丁。** 否决：崩溃与 koffi 版本无关（3.1.1 复现、3.1.5 亦有报告），锁版本无济于事；给 vendored 原生代码打补丁是为一个库本身已安全暴露的读取操作买维护负担。
- **用 `koffi.decode` 按 `uint16_t` 逐元素手工循环读取。** 否决：最长 32 KiB 的路径意味着逐元素调用，更慢也更多代码，且没有可移植性收益——`wstring` 是在 addon 内部完成的同一操作。
- **收窄仓库 `engines` 范围以排除受影响运行时。** 作为本缺陷的修复予以否决：坏的是选择器这个组件；`decode.wstring` 在两个受支持运行时上都已验证，没有残留缺口需要围栏。

## Consequences

- 安装版桌面端的文件夹选择可以完成；worker 正常上报 `{kind:'done', path}`，不再死于 `readUtf16`。
- `Koffi` 接口不再声明 `view`，后来者无法在这个类型化表面上无意中重新引入会崩的调用，除非有意重新添加。
- 选择路径仍靠真实 Windows 上的人工验证（冒烟只覆盖打开并中止）；mocked-COM 测试钉住了包含 wstring 读取在内的提取时序，逐文件 100% 覆盖保持成立。
