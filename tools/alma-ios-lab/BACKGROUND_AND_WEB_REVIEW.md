# Litter 手机 Agent：后台执行与 Web 评估

2026-11-01，Asia/Shanghai。源码基线仍为 Litter `366aefdd…`、Codex `6ff1e1ca…`
（0.166.0）；本轮未重新追踪最新 release，也没有改动 App、登录账号、调用模型或进行
后台真机测试。上轮 iSH 真机报告只覆盖前台工具，不能作为本报告两项能力的通过证据。

后续同日的隔离讨论和逐项修法已合并进[待审核实施清单](IMPLEMENTATION_PLAN.md)。本文
保留后台/Web调查依据，实施范围和顺序以清单为准。

## 结论与范围

- **H2：后台长任务为新的可行性验证阻断项。** 有官方实现路线，但尚不能承诺当前组合能
  在正常锁屏/切 App 后稳定完成十几分钟乃至更长的真实 Agent 任务。不是已证明不可行。
- **M9：纠错所用 Web 能力存在明确保留路线。** 官方搜索和网页读取主要在 Provider
  服务端完成，手机执行原生网络请求/事件处理，不要求 iSH 内有 Chromium、Node JIT。
  真实账号可用性和完整工具链仍待验证。
- 用户已将两项纳入 P0；此前只测前台的 L4 条件撤销。后续隔离路线见实施清单。
- 用户手动划掉 App、断网、资源极端紧张需独立记录，不与普通锁屏混为一谈；恢复成功
  不可冒充期间连续执行成功。

## 后台：现状与可采用的机制

Litter `AppLifecycleController.swift:124–166` 在切后台时记录活跃 turn、同步 Live Activity、
注册 push proxy，并调用 `UIApplication.beginBackgroundTask`。到期回调只结束该申请。
源码没有 `BGContinuedProcessingTask` / `BGProcessingTask` 接入。Info.plist 声明的
audio/fetch/remote-notification 不能等价于本地 Agent 获得十几分钟执行权；Live Activity
用于显示状态，也不能独立保证 Codex/iSH 继续执行。

Apple 从 iOS 26 起提供 `BGContinuedProcessingTask`，允许用户在前台明确启动、具有可见
完成目标的任务继续到后台。官方文档明确允许网络和 CPU 工作；GPU 是另外按设备判断的
可选资源。Agent 本身以云端推理、原生网络和 iSH CPU 工具为主，因此这条路线不需要先
解决 Gemma 的后台 GPU 权限。它也不是 Apple Intelligence/PCC 的硬件资格问题。
此前连接的 iPhone 12 Pro 为 iOS 27.0.1，满足 API 的 OS 版本门槛，实际调度仍需测试。

本机 iPhoneOS SDK 同时确认：默认资源是 CPU/network；iOS 27 新增异步
`submitTaskRequest:completionHandler:` 以捕获完整提交错误。测试实现应区分请求已提交、
handler 真正启动、进度推进、到期与完成，不把无同步错误当成运行成功。

该 API 不是固定保障 20 分钟的租约。Apple 可以因资源、进度或用户取消而终止任务；
没有文档承诺所有设备与条件下都能连续跑固定时长。普通 BGProcessingTask 的启动时机
由系统安排，可作为以后补做工作的候选，不能保证用户点击后立即处理。

### 对 Agent 最关键的未知

1. **进度稀疏。** 模型排队、长推理、一次网页请求期间可能没有新的可报告进展。
   Apple 要求真实进度；DTS 在 2025-11 的个案回复中提到大约 30 秒无更新可能被视为停滞，
   同时明确这不是公开固定常数。不能把该数字当成 iOS 27 的硬编码规范，也不能通过虚假
   心跳百分比规避。需比较实际模型/工具事件、已完成阶段等能否提供足够且诚实的进度。
2. **后台与锁屏分别测。** 有执行权仍需验证流式连接、接收结果后新发起下一次请求、iSH
   子进程与文件新建/原子改名在锁屏下正常。仅服务器完成当前回答不代表本地 Agent loop
   已能继续工具调用和下一轮推理。
3. **状态与文件。** Litter ChatGPT token Keychain 使用
   `kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`，设计上允许首次解锁后在后台访问；
   不代表所有工作文件、fakefs 元数据、SQLite/WAL、运行时 auth 文件已验证可在锁屏下使用。
   这些须检查实际保护属性，不要简单把所有数据保护关闭。
4. **中断后的续作。** 保存已完成 revision、工具执行状态和请求标识；取消必须传到执行器，
   恢复需核对文件副作用，不能盲重放。系统杀进程不保证调用清理回调，不能只靠结束回调保存。
5. **任务触发方式。** 新 API 要求明确的用户操作。点击“整理笔记”很吻合；仅设置一次
   “自动整理”后未来自动启动不能直接假设符合该 API 使用条件，产品触发方式需对齐。

后台 URLSession 适合系统托管上传/下载，不能直接把现有 Rust HTTP/流式模型通信、任意
iSH 命令与整套 Agent loop 搬进系统后台传输服务。推送也不能代替本地执行权。

## Web：明确区分已有能力与额外能力

Mac TAH `app/TAH/providers/codex/adapter/src/native-profile.ts` 已有以下设置：

- `web` 能力映射到 `web_search` / `provider_web`（16–19 行）。
- 获得 Web 权限时 `web_search = "live"`，否则 disabled（188–190 行）。
- `browser_use`、`browser_use_external`、完整 CDP、`in_app_browser` 当前关闭。

因此复制现有纠错能力，需要保留官方 Web 搜索/页面内容工具；无需先搭完整桌面浏览器。
这并不代表可以访问所有登录网页、解决验证码或执行任意网页 JavaScript。

Codex 0.166 源码有两条路：

| 路径 | 证据 | 手机依赖 |
|---|---|---|
| Hosted Web | `core/src/tools/hosted_spec.rs` 将 Web 工具声明放进模型请求；`protocol/src/models.rs` 有 Search/OpenPage/FindInPage；stream handler 消费返回的 WebSearchCall | 原生模型连接、事件/结果处理，无本地 shell 搜索引擎 |
| Standalone `web.run` | `ext/web-search/src/tool.rs` 使用 Provider auth 和 `SearchClient`；`codex-api/src/endpoint/search.rs` 发到 Provider 的 `alpha/search`；返回文本重新加入模型上下文 | 原生 HTTP、认证续期、扩展注册、结果引用；不是 iSH 执行 curl |

`app-server/src/extensions.rs:111` 注册 standalone 扩展。`core/src/tools/spec_plan.rs`
按模型、feature 与工具注册情况选择 hosted/standalone；Responses Lite 路径不提供 hosted
fallback，不能在移植中顺手删掉扩展然后假设搜索还在。Standalone schema/描述支持
search/open/click/find/PDF screenshot 等；部分能力由模型元数据控制，源码列出不等于
该订阅账号和模型已通过在线验证，也不保证所有网页内容都可获取。

旧 Litter `conversation.rs:482` 已接收 WebSearch query/action；升级到新版 ThreadItemPayload
后需要同步结果与 UI 映射。不能只看到“搜索中”的 UI 就判定正文与引用真正回到模型。

这一机制是在原 Codex 认证和 Provider 协议中调用官方 Web 服务。没有必要另接一个按量
付费的搜索 API；本轮也没有测试账号额度、服务端授权或计费，不能据此作额外免费承诺。
如果任务另需 Python requests/curl 下载文件，那是独立的 guest 网络/TLS 能力，上轮工具
测试未覆盖，不能以原生 Web 工具的可行性替它背书。

## 下一轮验证设计（尚未执行）

1. 小型独立后台探针复用已验证的 iSH 嵌入 API，增加官方 continued-processing 管理，
   不接 ASR/Gemma，不留模型文件。Release 真机、无调试器，分别记录切 App 和真正锁屏。
2. 先执行 CPU 文件处理与原生 HTTPS 请求交替的 20–30 分钟任务；加入 15/45/120 秒
   等待与真实进度稀疏情形，不假造进度。记录 handler 启动、首个进度空档、最后网络事件、
   到期回调、footprint/thermal、文件哈希和完成状态。短倒计时不是通过标准。
3. 通过基础探针后，接好新版 Codex 和用户订阅登录，在前台验证一次完整
   搜索→打开页面→页内查找→可核对引用→纠错写入。区分网络/鉴权/配置/结果映射错误。
4. 用同一 Structured Note 长任务做前台、切 App、锁屏对照，测所有阶段耗时和中断位置；
   同时验证切回后不重复写 revision。必要时分别覆盖 hosted 与实际启用的 standalone 路径。
5. H2 降级需要上述正常场景可重复通过、失败可解释且可恢复。若系统持续收回执行权、且
   等待云端结果无法提供合适进度，则需讨论产品边界或用户 Mac 执行方案，不能靠重复申请
   短时后台任务宣称解决。后续已完成隔离路线讨论，边界验证和后台探针可独立推进。

## 官方来源与本地核对点

- [Apple：长任务](https://developer.apple.com/documentation/backgroundtasks/performing-long-running-tasks-on-ios-and-ipados)
- [Apple：BGContinuedProcessingTask](https://developer.apple.com/documentation/backgroundtasks/bgcontinuedprocessingtask)
- [WWDC25：Finish tasks in the background](https://developer.apple.com/videos/play/wwdc2025/227/)
- [Apple DTS：后台执行边界，2026-01 更新](https://developer.apple.com/forums/thread/685525)
- [Apple DTS：进度稀疏导致过期](https://developer.apple.com/forums/thread/805554)
- [Apple DTS：子进度与 completedUnitCount 个案](https://developer.apple.com/forums/thread/809182)
- [Apple：后台 Keychain 访问](https://developer.apple.com/documentation/security/ksecattraccessibleafterfirstunlockthisdeviceonly)
- [OpenAI：Codex Web 配置](https://learn.chatgpt.com/docs/config-file/config-basic#web-search-mode)
- [Codex 0.166 Web 实现](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/ext/web-search/src/tool.rs)
- [Litter 生命周期](https://github.com/0xSero/litter/blob/366aefdd616f16b9efb6c888be6cfd916bda47d6/apps/ios/Sources/Litter/Models/AppLifecycleController.swift)

Apple 文档页的 Markdown 通过官方 `.md` 入口读取；本地 SDK
`BackgroundTasks.framework/Headers/{BGTask,BGTaskRequest,BGTaskScheduler}.h` 交叉核对了
iOS 26/27 availability、默认资源与提交 API。论坛的历史问题不能证明当前手机也有同样 bug；
未以搜索摘要中的旧锁屏报告断言 iOS 27 必然失败。
