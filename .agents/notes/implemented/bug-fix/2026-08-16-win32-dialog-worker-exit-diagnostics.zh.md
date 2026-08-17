# Agent Note: Win32 dialog worker exits report status and stderr

Status: implemented

[English](2026-08-16-win32-dialog-worker-exit-diagnostics.md) | 中文

## Problem

某台机器上，安装版桌面端每次点击"选择工作区"都报 `win32 folder dialog worker exited before reporting a result`：对话框子进程在发出任何 IPC 消息前就死了，而这条干巴巴的拒绝消息没有任何可诊断的信息——没有退出码、没有信号、没有子进程输出。该故障在其他任何地方都复现不了（shell 启动、GUI 启动、Explorer 启动的会话都能正常弹框），唯一可行的方向是让下一次失败自己报告死因。那台机器上最可疑的元凶是安全软件杀掉了刚安装的子进程，但原错误消息无法证实也无法排除这个假设。

## Decision

`spawnDialogWorker` 现在把 worker 的 stderr 改为管道捕获（此前是继承），并返回包了一层 `DialogWorkerProcess` 的子进程（`win32-dialog-host.ts`）：它保留最多 4 KiB 的 stderr 尾部，并把子进程的 `close` 事件作为面向 driver 的 `exit` 转发——用 `close` 而非 `exit`，因为 Node 可能在 stdio 流排空前就触发 `exit`，那恰好会在读取尾部时把它截断。driver 的 exit 拒绝路径（`win32-dialog.ts`）现在会写明状态——`exit code N`（N 超过 255 时附十六进制，让 0xC0000005 这类 NTSTATUS 致命码一眼可辨）或 `signal SIGx`——并在 stderr 尾部非空时附上它。`Win32DialogWorkerLike` 增加了双参数 exit 监听签名和可选的 `stderrTail()`；`node:child_process` 在结构上仍满足该接口。子进程 + koffi 的总体设计不变（见[拥有该决策的 feature note](../feature/2026-08-02-win32-in-process-folder-dialog.md)）。

## Alternatives considered

- **静默退出时自动重试。** 否决：为未确认的原因做投机处理。安全软件击杀在重试时会原样重演，原生崩溃重试也是同样的崩溃；而插桩错误能把下一次失败变成可行动的证据。
- **保持 stderr 继承，让受影响的用户提供控制台日志。** 否决：安装版 GUI 没有附着控制台，子进程的输出无处可达；只有管道捕获才能让输出留存下来被上报。
- **转发子进程的 `exit` 事件而非 `close`。** 否决：Node 文档明确 `exit` 可能先于 stdio 流关闭触发，诊断信息会和自己的证据赛跑。

## Consequences

- 下一次静默退出失败会自带死因：退出码或信号，外加最多 4 KiB 的 worker stderr。安全软件击杀表现为致命码（1，或渲染为 `0xc0000005` 的 3221225477）配空尾部；模块加载或 koffi 失败则会在尾部带上 Node 调用栈。
- 终端启动时 worker 的 stderr 不再到达父进程控制台；它只出现在抛出的错误里。
- `win32-dialog.spec.ts` 用 fake 钉住了新的消息形态（退出码、十六进制码、信号、stderr、空尾部），新增的 `win32-dialog-host.spec.ts` 用真实免密钥子进程在所有平台上钉住事件转发、有限尾部与 kill 透传。两个源文件的逐文件 100% 覆盖保持成立。
