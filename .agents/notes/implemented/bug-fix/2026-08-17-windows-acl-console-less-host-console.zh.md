# Agent Note：windows-acl 后端要求无控制台宿主先持有控制台

Status: implemented

[English](2026-08-17-windows-acl-console-less-host-console.md) | 中文

## 问题

在打包的桌面外壳（Electron GUI——其进程树中没有任何控制台）里，每条受限 shell 命令都以退出码 3221225794（`0xC0000142`，`STATUS_DLL_INIT_FAILED`）死亡且零输出；同一命令在非受限（`danger-full-access`）下正常运行。对失败链路的每一种独立重放——相同二进制、相同 runner argv、相同工作区、相同 SID 对、相同环境块、相同管道 stdio 形态、完全一致的父令牌组列表——在活的应用之外全部成功，因此触发点被锁定在应用自身的进程上下文内：给已安装的 runner 插桩调试循环后，垂死子进程的 loader snaps 输出显示进程初始化在只映射了 ntdll/kernel32/KernelBase 之后，死于 KernelBase 的 `DLL_PROCESS_ATTACH` 内部。随后在应用运行时内执行创建标志探针矩阵，确定了问题形态：所有触碰控制台的变体（无标志、`CREATE_NO_WINDOW`、`CREATE_NEW_CONSOLE`）都以 `0xC0000142` 死亡；`DETACHED_PROCESS` 能启动但 PowerShell 空转退出（不执行命令、退出码 0、无输出——假阳性）；而先给自己分配控制台的 runner 产出的受限子进程能正常 attach 并输出真实结果。该受限方案已验证的设计——子进程共享宿主控制台（[设计笔记](../feature/2026-08-08-windows-acl-restricted-token-sandbox.md)）——隐含假设了宿主拥有控制台；桌面外壳是第一个无控制台宿主。

## 决定

seam 为无控制台宿主提供一个贯穿其生命周期的隐藏控制台。`ensureHostConsole`（`sandbox-windows-acl/src/console.ts`）仅在进程没有控制台时（`GetConsoleWindow`）分配一个，并立即隐藏（`ShowWindow` `SW_HIDE`）；`dsh-sandbox-local` 在每次 windows-acl 包装前调用它（`windowsAclRunnerArgv`），仅限 win32，测试中可通过 `internals.ensureConsole` 注入。受限子进程随后继承宿主的控制台 attachment——正是 CLI 验证所固定的形态。该适配刻意是尽力而为：`AllocConsole` 被拒绝时保留原有行为，而不是破坏那些无控制台路径恰好可用的宿主，因为该失败对无控制台宿主并不普遍。覆盖：`console.spec.ts` 用桩绑定固定 `ensureHostConsole` 的全部四个分支；`sandbox-local` 的 `local.spec.ts` 固定每次 windows-acl 包装都应用该钩子；一个 runner e2e 从任意终端复现无控制台宿主（包装入口在加载 runner 前调用 `FreeConsole`，然后应用该适配），并断言受限 PowerShell 既存活**又**产出真实输出——正是排除 `DETACHED_PROCESS` 空转假阳性的那条断言。

## 已考虑的替代方案

- **在无控制台宿主上使用 `DETACHED_PROCESS` 子进程。** 否决：子进程能启动但 CUI 工具不执行命令（PowerShell 退出码 0、无输出），在桌面外壳与本地试验装置中均已验证——退出码 0 的静默空转，比响亮失败更糟。
- **`CREATE_NO_WINDOW` / `CREATE_NEW_CONSOLE`。** 已有文档记载在该受限方案下死亡；在桌面外壳的探针矩阵中再次验证死亡。
- **在逐命令的 runner 内分配控制台。** 否决：控制台随其最后一个附加进程消亡，逐命令分配会导致每条命令都闪一次控制台窗口；控制台必须属于长生命周期的提供方进程，其 attachment 被每个 runner 与受限子进程继承。
- **修复控制台创建失败本身。** 不可行：失败位于此宿主形态下 `WRITE_RESTRICTED` 令牌里 KernelBase 的控制台初始化内部，POC 有文档记载的 SID 尝试（`S-1-2-1`）已经失败；继承现有控制台是已验证的可用路径。

## 后果

- 打包桌面外壳：受限 pwsh 命令正常运行并产出真实输出；每个运行时生命周期一个隐藏控制台（一个 conhost.exe），在首次受限包装时建立。
- 非 Windows 平台不受影响（调用有 win32 门控）；已持有控制台的宿主走无操作快路径。
- `win32-abi.ts` 的控制台注释与两个包的 README 现均载明宿主控制台要求；设计笔记的控制台条款交叉链接本笔记。
