# 历史审查：Litter 对应的 Codex 0.155.1

> 本文保留首轮审查和实测证据。这里的 P1/P2 是旧的影响严重度标记，
> 不采用用户后来定义的 high/middle/low 可解决性分档。当前结论以
> [对最新稳定版 0.166.0 的审查](README.md)为准；不能用本文证明与最新版兼容。

2026-10-31。用户将 P0 收窄为：先理解、验证 Litter，再考虑手机完整 App。
本轮没有接入录音/标题/Agent UI，没有安装手机 App、登录账号或调用模型。
此前开始的 ASR 静态库构建和 Preview `npm ci` 已结束，只生成忽略的本机构建产物；
它们不属于 Litter 测试证据，也没有改 Preview 的功能源码。

## 结论与证据等级

Litter 是有价值的 **Codex 移动端移植参考**，但当前固定版本不能作为已经与桌面 Codex
等价的黑盒直接并入 ALMA。主要差异集中在宿主适配，而非重新实现模型的 Agent loop。

- **已运行验证**：14 个补丁按原顺序全部严格应用成功，涉及 57 个去重文件；
  Rust 源码片段复现中文/emoji 截断 panic；Swift 原条件复现账号一致性检查漏洞。
- **源码确认的行为差异**：iOS unified exec 不走原来的进程管理路径；环境变量被忽略；
  native apply_patch 与 iSH shell 使用不同文件系统入口；外部凭证续期请求未找到有效应答链路。
- **尚未完成端到端验证**：整套 Litter 的编译/启动、实际 OAuth 续期、iSH 命令取消和
  文件映射、后台挂起/恢复、真实任务语义质量、手机内存/延迟。

纯函数或源码片段测试不是整机测试。没有把原版 Codex 的成熟度、Litter 的 CI 配置或
App Store 可下载状态当成 ALMA 工作流已通过的证据。

## 固定对照基线

| 项目 | 固定版本 |
|---|---|
| Litter | `366aefdd616f16b9efb6c888be6cfd916bda47d6`，2.1.9 |
| 对应官方 Codex | `be2951ea34f0d295ed0becf97079f92fa5f6950e`，Litter 文档标注 rust-v0.155.1 |
| iSH fork | `dnakov/litter-ish`，Cargo.lock 固定 `4f783cd957b83de3019d6a843408d5bb3ff902c7` |
| Alpine rootfs | Litter Makefile 固定 `v0.1.2`；原下载脚本核验 release SHA256SUMS |
| Codex 源码归档 | 14,497,620 bytes；SHA-256 `cd5a884836b53422052989479c6662f06e2ee8bb768c1a86a5ff7326b887d4d6` |

对照同一上游基线，避免把后来 Codex 的变更误认成 Litter 的移植变更。
官方归档在 `.cache/codex-be2951ea.tar.gz`；干净源码在同名完整 SHA 的目录。
Litter 在 `.cache/litter`。未运行其构建/发布脚本，也未修改这些上游源码。

## 逐项比较

| 部分 | 桌面 Codex / 官方基线 | Litter 当前实现 | 对 ALMA 的意义 |
|---|---|---|---|
| Agent 主循环 | Codex core，CLI/app-server 共用能力 | 原生 Rust，`in_process::start`；没有把整个核心交给 Linux 模拟器 | 适合作为保留原厂核心的候选；不等于运行默认值完全一致 |
| 启动配置 | 从桌面 CLI/app-server 配置初始化 | 自己组装 `InProcessStartArgs`；默认打开 goals/realtime 等，SessionSource 为 VSCode | 接入时需要显式核对模型、推理等级、工具与持久化目录，不能照抄全部默认项 |
| ChatGPT 登录 | 官方登录/凭证管理 | iOS Swift OAuth + Keychain，再以 `chatgptAuthTokens` 交给 app-server | 支持订阅路线，但客户端承担续期责任；见 R2、R6 |
| 模型请求与上下文 | 官方模型客户端、流式事件、压缩等 | 主要复用上游；补丁也修改 SSE 工具参数 delta 与实时语音协议 | 普通文本请求并非另写一个简易 Agent loop；仍须实测模型访问和长会话 |
| Shell / 命令执行 | 真进程、进程组、可持续 exec 会话、stdin、退出状态 | exec hook → iSH；unified exec 新增专用分支 | 这是最大的行为变化，见 R3、R4 |
| 文件修改 | 工具使用执行环境相应文件系统 | shell 使用 iSH fakefs/realfs；特殊 apply_patch 使用 native `LOCAL_FS` | 同名路径未必是同一个文件，见 R5 |
| 权限与网络 | 进程启动、sandbox、网络审批监视等共同执行 | iOS unified exec 在 `open_session_with_sandbox` 之前返回 | 不能沿用桌面进程隔离的验收结论；也不能说所有上层审批都被取消 |
| 环境变量与 shell | 每次命令获得本次构造的 env 和相应 shell | `_env` 被忽略；固定 `runtime_env()`，shell 包装改成 `sh -c` | PATH/代理/任务变量和 bash/zsh 特有语法不等价 |
| Web / HTTP | 云端工具、原生模型 HTTP、shell 网络、MCP 是不同路径 | 模型请求主要复用原生 Codex；iOS 另提供 CA bundle；shell 网络由 iSH 路径承载 | 必须分别测模型连接、web 工具和 shell HTTP，不能用一个成功推断全部成功 |
| MCP / 外部工具 | 可启动本机子进程或连接服务 | 移动 hook 主要接 core exec；没有据此证明所有独立子进程入口均被适配 | stdio MCP、hook 脚本等暂不列为已支持；HTTP MCP 也需要单独验收 |
| 事件与 UI 状态 | app-server 持续发送请求、结果、通知 | Rust reducer + Swift snapshot；部分原始通知被丢弃，event-reader Lagged 分支只记日志 | 需要证明工具审批/结束事件不会导致永久等待或错误完成，见 R2、R8 |
| 会话保存与恢复 | 上游 rollout/thread store | 基本复用，另有 fork 列表补丁、分页和 UI hydration | 存在恢复机制，不能替代实际杀进程/重开验证 |
| iOS 后台 | 桌面进程通常不受手机挂起方式约束 | `beginBackgroundTask`，到期结束后台任务；回前台重连/重读 | 没有证明本地 Agent 可以在锁屏后无限执行，见 R9 |
| 远程 Mac 路线 | 在远程机器运行官方 app-server | SSH/WS/Alleycat 等，支持重新连接 | 可以作为未来替换执行后端的参考；重发语义需另测，见 R10 |
| 日志 | 配置化记录 | exec hook 直接打印完整命令和输出预览 | 不符合 ALMA 仅记录运行元数据的预期；见 R7 |
| 可复现构建 | 固定依赖与平台目标 | 有 lockfile、固定 gitlink、rootfs 版本和校验，但 build-rust 没有 `--locked`；iSH manifest 写 branch=main | 后续构建应强制锁定全部依赖，不运行 cargo update；不能只锁顶层 repo |

## 问题清单

### R1 — P1：中文/emoji 命令输出可能令进程崩溃（已复现片段）

`ish_exec.rs:91–96,135–140` 对 UTF-8 字符串执行 `&preview[..200]`。
如果第 200 个字节落在多字节字符内部，Rust panic。两条 exec 路径都有此代码。
输入 70 个“中”或 `a` + 50 个 emoji 均复现；220 个 ASCII 字符不触发。
release profile 为 `panic="abort"`，因此该路径在相应 release 构建中会终止进程。
这不是模型语义问题，也不需要恶意输入，读取中文转写就可能产生这样的输出。

证据：[原代码](https://github.com/0xSero/litter/blob/366aefdd616f16b9efb6c888be6cfd916bda47d6/shared/rust-bridge/codex-mobile-client/src/ish_exec.rs#L91)。
建议接入前移除正文预览日志，或采用字符边界安全截断；本轮未修上游。

### R2 — P1：账号续期请求缺少完整应答（静态调用链）

Swift 登录调用 `loginAccount(.chatgptAuthTokens(...))`；因此上游使用 external-auth bridge。
它在 401 后发 `account/chatgptAuthTokens/refresh` 并等待客户端最多 10 秒。
Litter 的 `session/events.rs:683–690` 将请求变成 RawNotification；
`mobile_client/event_loop.rs:131–169` 只为 DynamicToolCall 启动应答，
`store/reducer.rs:2499` 对 RawNotification 不处理。
检查 iOS Swift 与 Rust 事件消费处，未找到将这个请求接入 Swift refresh 并回送结果的分支。
启动时主动刷新凭证存在，但与“运行中的 401 续期请求”不是一回事。

预期后果：首次登录/短任务可正常，凭证过期的后续任务在恢复认证时超时或失败。
尚未做真实账号过期测试；不能描述为已经在手机上观察到该故障。

证据：[登录](https://github.com/0xSero/litter/blob/366aefdd616f16b9efb6c888be6cfd916bda47d6/apps/ios/Sources/Litter/Models/AppModel.swift#L533)、
[请求处理](https://github.com/0xSero/litter/blob/366aefdd616f16b9efb6c888be6cfd916bda47d6/shared/rust-bridge/codex-mobile-client/src/mobile_client/event_loop.rs#L131)、
[上游续期桥](https://github.com/openai/codex/blob/be2951ea34f0d295ed0becf97079f92fa5f6950e/codex-rs/app-server/src/external_auth.rs#L18)。

### R3 — P1：取消、超时、交互命令不再等价（源码确认；真机待测）

`ios-exec-hook.patch` 的 `exec_command_ios`：

- `spawn_blocking` 调 iSH，传入 `timeout_ms=None`，不转交取消令牌；
- 等命令完全退出后才返回，返回 `process_id=None`；没有原来先 yield、再 write_stdin 的进程登记；
- hook 使用 unbounded channel；iSH drain 持续把全部输出追加到 Vec，未见总量上限；
- 非 unified 的 exec 分支也把 `timed_out` 固定为 false，并把 stderr 合并进 stdout。

iSH 固定依赖的 `drain_to_completion_streaming` 中，None 表示没有总截止时间；
`unwrap_or(60_000)` 只是每次 read 的等待时间，循环会继续，不是 60 秒总超时。
因此不能认为取消 Rust future 就能停止已经开始的阻塞 shell 工作。
需以带外超时保护的最小命令验证：长等待、等 stdin、取消后继续写文件、超量输出。
不能为验证而直接运行无上限循环或输出洪水。

证据：[iOS 补丁](https://github.com/0xSero/litter/blob/366aefdd616f16b9efb6c888be6cfd916bda47d6/patches/codex/ios-exec-hook.patch)、
[iSH drain](https://github.com/dnakov/litter-ish/blob/4f783cd957b83de3019d6a843408d5bb3ff902c7/embed/host/src/instance.rs#L559)。

### R4 — P1（ALMA 接入）：权限和工作区隔离需单独实现/验收

iOS unified-exec 分支在原版 `open_session_with_sandbox` 前分流，不经过其进程创建与网络
拒绝监视逻辑。iSH 常驻实例也不同于 TAH 原先每次 attempt 的独立 VM。
这不等于可以逃出 iOS App 系统沙盒，也不等于所有用户审批都被绕过；但不能证明
Raw Guardian 只读、Actor 只写本轮候选、旧 revision 不可修改等 ALMA 边界仍然成立。
需分别审计 native 文件工具与 guest 文件工具，不能靠 prompt 声明安全边界。

证据：同 R3；官方基线 `core/src/unified_exec/process_manager.rs:504`。

### R5 — P1 验证项：两套文件路径是否一致

LitterPlatform 主动把 iOS 宿主目录迁移为 `/root`；注释明确 iSH 看不到原生容器路径。
shell 工作在 iSH fakefs，并把 Documents/Apps 挂到 `/mnt/apps`。
另一方面，特殊 apply_patch 调 `codex_exec_server::LOCAL_FS`，没有看到相应路径转换。
因此必须验证 shell 写入、native 读取、native patch、shell 重读看到同一份字节。
不能先把 `/root` 或 `/mnt/apps` 当成原生可访问目录。当前没有完整 iSH 真机结果，
故列为高优先级待验证项，而非宣称每次 patch 必然失败。

证据：[路径选择](https://github.com/0xSero/litter/blob/366aefdd616f16b9efb6c888be6cfd916bda47d6/apps/ios/Sources/Litter/Models/LitterPlatform.swift#L105)、
[native patch](https://github.com/0xSero/litter/blob/366aefdd616f16b9efb6c888be6cfd916bda47d6/shared/rust-bridge/codex-mobile-client/src/ish_exec.rs#L33)。

### R6 — P2：刷新账号检查的布尔条件放过错误变化（已复现纯条件）

`ChatGPTOAuth.swift:245–248` 仅在 refreshed 和 stored **都**不同于 previousAccountID 时拒绝。
expected=A、stored=A、refreshed=B 会被接受并保存；条件不能保证刷新后仍是要求的账号。
用原条件和虚构账号 ID 在 Swift 中复现，无真实 token、请求或用户账号。
这证明校验条件有问题，不证明 OAuth 服务实际曾返回了别人的账号。

证据：[原条件](https://github.com/0xSero/litter/blob/366aefdd616f16b9efb6c888be6cfd916bda47d6/apps/ios/Sources/Litter/Models/ChatGPTOAuth.swift#L245)。

### R7 — P2（ALMA 接入）：命令和输出正文进入日志

`ish_exec.rs:86,98,125,142` 使用直接 eprintln，含命令和输出前缀，不由 tracing 的
release 级别开关消除。对 ALMA 来说，命令可能带笔记内容，读取结果可能带转写正文。
不应将此日志策略直接合入。没有记录本人的真实 transcript 或凭证来做验证。

### R8 — P2 验证项：事件溢出与状态恢复

本地连接广播容量为 256。event reader 遇到 Lagged 只记日志；原始通知又存在丢弃分支。
UI 有重读和全量 snapshot 机制，但不能假设它自动补回已经丢失的服务端审批请求。
需要用有限、可计数的流式事件和工具请求测试“结束状态不丢、审批不永久等待”。
尚未复现真实负载下溢出，不报告为每次必现。

### R9 — P2 验证项：后台恢复不等于本地任务一直执行

`AppLifecycleController.swift:158–164` 申请有限后台时间，到期结束后台任务；回前台有
重连/重读流程。远端任务可在另一台机器继续，不代表手机进程内任务也具备相同持续性。
需分别测：短暂切后台、锁屏较久、强制退出后重开。完成结果必须依据真实持久化状态。

### R10 — 未来 Mac 中转验证项：传输错误后的重发

远程 worker 在传输错误后可重新发送原请求一次（`connection.rs:1611–1629`），
该判断本身未按只读/写入方法分类。对于 turn/start 这类可能已经被服务器接受的请求，
必须验证不会重复启动或重复应用修改。当前未复现重复副作用；不能假设服务器已提供
跨重连的幂等保证。此项属于远程后端，不混为本地 Codex 的既有故障。

## 补丁覆盖范围

完整补丁清单、逐文件列表和 SHA-256 见
[机器可读结果](results/2026-10-31-source-probes-verified.json)。

| 补丁 | 主要作用 |
|---|---|
| mobile-crypto-compat | 调整加密依赖版本以兼容移动 SSH 依赖 |
| ios-exec-hook | 替换命令执行入口；本轮最高风险区域 |
| thread-read-permissions | 返回运行中的审批/sandbox 信息 |
| thread-list-fork-lineage | thread 列表及 fork 祖先关系 |
| mobile-shell-snapshot-timeout | 移动 shell snapshot 从 10 秒改为 2 秒 |
| remote-app-server-websocket-cap | 为 SSH 等自定义流接入通用 wire |
| absolute-path-cross-platform | 跨 Windows/POSIX 的路径反序列化 |
| android-installation-id-lock | Android 安装 ID 文件锁兼容 |
| dynamic-tool-call-arguments-delta | SSE/协议/UI 的工具参数增量事件 |
| approval-timestamps-serde-default | 审批时间字段缺省兼容 |
| realtime-webrtc-env-apikey | 实时语音 API Key 及 endpoint 选择 |
| realtime-handoff-server-hint | 实时语音 handoff 目标标识 |
| realtime-dynamic-tools | 实时语音动态工具调用 |
| realtime-client-controlled-handoff | 由客户端处理实时语音 handoff |

所有补丁在本轮固定基线上严格应用成功，不依赖 sync-codex.sh 的“前几行已存在”宽松
内容判定。成功应用不代表编译通过或行为正确。原 CI 配置包含 Rust 与模拟器测试，
这是积极证据，但本轮没有运行完整 CI，也不把 CI 配置当作真实手机验收结果。

## 接下来最小验证顺序（尚未执行）

1. 先处理 R1、R2、R3，以及确定文件工具的统一路径；保留精确版本与小补丁。
2. 用独立的 Litter 测试壳跑登录、中文文件读取/修改/重读、受控取消；不连接录音模型。
3. 测凭证过期/恢复，App 中断与重开；日志不含正文/token。
4. 再用同一组输入跑 TAH Raw Guardian、V0、V1、V2；验证两份 Markdown 和权限边界。
5. 只有这些通过后，再接 ASR、标题摘要和现有 Preview；Mac 中转仍作为独立 transport 候选。

没有在本轮擅自修补或削弱权限，也没有把任一问题视为必须放弃 Litter 的结论。
Litter 主项目标注 GPLv3 + App Store/Google Play 分发额外许可；代码复用与正式发行方案
应保留其许可证、归属和依赖清单。本次审查没有进行发行合规结论或重新分发构建产物。

## 复现本轮小测试

前置：按上述固定提交准备 `.cache/litter`，按记录的 SHA-256 准备官方 Codex tar.gz，
用 Python tarfile 的 `filter="data"` 解压到 `.cache/`。脚本会核验归档和解压后的每个文件。
需要本仓库既有 Rust toolchain、Xcode Swift；不需要额外模型或账号。

```sh
python3 tools/alma-ios-lab/audit_local.py --output /tmp/alma-litter-audit-new.json
```

临时补丁树和编译出的两个小探针会自动删除；结果路径必须未存在，避免覆盖历史证据。
这仅验证严格补丁应用和源代码片段，不构建/安装完整 Litter，也不运行云端任务。
