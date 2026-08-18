# Agent Note：windows-acl 默认 DACL 必须覆盖 pass-1，而不仅是 pass-2

Status: implemented

[English](2026-08-18-windows-acl-default-dacl-pass1.md) | 中文

## 问题

在打包的桌面外壳里，每条"自身再 spawn 子进程并捕获输出"的受限命令都会死：MSBuild 的 Csc 任务在启动 `csc.exe` 的那一刻报 `error MSB3883: 意外的异常` + `拒绝访问`（`ERROR_ACCESS_DENIED`），而普通命令和同样的非受限构建都正常。现场探针把失败锁定到一个系统调用：受限进程内的 `CreatePipe`（匿名管道创建）返回 `ERROR_ACCESS_DENIED`——命名管道的创建与打开、无重定向的 spawn、工作区/临时目录写入全部正常。而从终端重放同一受限链路（相同 runner 二进制、相同 SID 对、相同工作区、相同 seam 临时目录）却成功，因此触发点与宿主祖先链相关。

机制：runner 往受限令牌的默认 DACL 里并入一条 restricting SID（workspace-write 下是私有临时 capability SID）的全权 ACE，使新对象创建能通过 WRITE_RESTRICTED 的 pass-2 检查。但 capability SID 是 restricting SID，不是令牌的**组**，因此永远满足不了 pass-1（普通 DACL）检查。pass-1 是否授予创建者写权限取决于宿主令牌继承来的默认 DACL：终端启动的宿主带 `LA GA`（启用组），而桌面外壳的 Explorer 系令牌只带登录 SID 的 `GX|GR`（Administrators 在 LUA 标志下是 deny-only）——因此在桌面外壳下，受限子进程内的每次匿名管道创建都在 pass-1 处以 `ERROR_ACCESS_DENIED` 死亡，.NET Framework 的 `ProcessStartInfo` 重定向（走 `CreatePipe`）随之拖垮 `csc.exe` 的启动。两条链路的令牌转储证实了这一点（默认 DACL 的差异恰好就是 `LA GA` 与登录 `GX|GR` 那条 ACE），显式 SD 阶梯也证实：在应用内显式传 `Everyone FA` 描述符的 `CreatePipe` 成功，而所有默认 DACL 变体都失败。

## 决定

在两种模式下都往受限令牌的默认 DACL 并入 Everyone 全权 ACE——workspace-write 下保留 capability SID ACE 之外追加（`AclSandbox.init`）。Everyone 既是启用的令牌组（满足 pass-1）又是必需的 restricting SID（满足 pass-2），因此任何宿主祖先链下新对象创建都可用；read-only 原本就授予 Everyone，从未出問題。默认 DACL 只落在无继承的对象上（匿名管道、事件、互斥体）——工作区与临时目录的文件继承父目录 DACL——因此有文档的临时目录 capability 隔离不变；命名管道仍取 Win32 模板（管道捕获边界依旧，由未改动的 runner e2e 固定）。runner e2e（`runner.spec.ts` + `tests/fixtures/print-default-dacl.cjs`）断言受限令牌默认 DACL 在两种模式下都携带 Everyone ACE。

## 已考虑的替代方案

- **只授予 capability SID，并把 .NET Framework 重定向记为不支持。** 否决：MSBuild/`dotnet build` 的工具 spawn 正是这条路径，"沙箱下无法编译"对编码 agent 不是可行的边界。
- **让受限进程在运行期自行修补令牌。** 不可能，已实证：受限子进程内 `OpenProcessToken(TOKEN_ADJUST_DEFAULT)` 本身就被拒——授予必须发生在 runner 创建令牌之时。
- **用 Everyone 替换 capability SID ACE。** 否决，属于无谓改动：capability ACE 记录并保留了按会话的临时目录隔离意图；Everyone ACE 只是补上缺失的 pass-1 覆盖。

## 后果

- 打包桌面外壳：受限 `dotnet build`（MSBuild Csc 工具 spawn）与 .NET Framework `Process.Start` 重定向恢复正常；每个受限令牌的默认 DACL 多一条 ACE。
- 受限进程不带显式描述符创建的命名同步对象变为 Everyone 完全访问；无名对象（匿名管道）仍是句柄作用域。read-only 模式原本就是这个形态。
- 从未踩到该缺口的宿主（终端启动）只是多一条冗余但无害的 ACE。
