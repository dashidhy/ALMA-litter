# 单 Provider 持续会话接入

2026-11-17 授权范围：分别接入 Kimi、ZCode，验证真实多轮、正常重开、共用 Skill 的显式和自然语言调用。跨 Provider／授权的对话交接不在本轮范围。导航 WIP 已按校验后的补丁反向隔离，保留在 ALMA 的导航待办档案中。

## 状态归属

- Alma 的 Rust 会话服务拥有 session、唯一公开对话 journal、固定 Provider／授权绑定、运行准入和公开事件投影。
- 原生 SDK 拥有自己的 session ID、历史、压缩和内部状态。不能每次新建后拼用户历史伪装续聊。
- Swift 只负责 Keychain、浏览器登录和平台生命周期；React 继续使用既有按轮对话界面。
- 单个测试 workspace 固定一个 Provider／授权。切换到另一个 Provider 要打开独立测试 workspace，本轮不提供原会话换 Provider 的入口。

## 持久化与运行

```text
打开 workspace → 恢复授权 → 打开/恢复原生 session → 保存原生 ID
用户消息 → 同一原生 ID → 公开事件写入 Alma journal → 结束本轮
关闭运行 → 排空进程/网络/临时文件 → 保留原生 home 与业务文件
再次打开 → 同一授权/目录/原生 ID → 原生恢复 → 继续用户请求
```

Kimi、ZCode 复用既有一轮执行的 guest/HTTPS transport，增加独立 session 模式；可以在每轮之间释放进程，下一轮由 SDK resume，保持原生会话身份和完整持久上下文。原生 ID 只有在 SDK 确认创建/恢复成功后才成为有效绑定。

`provider-state/<provider>/<authorization>/<session>` 保存 SDK 私有状态；workspace 稳定且直接读写 assets，共用 Skill 只读。SDK 的目录必须可写，模型文件工具只允许业务目录及共享 Skill；不能因为 SDK 需要写状态就把私有 home 当作模型可访问工作区。

Kimi 保持原路径已有文件工具；新路径增加 Skill。ZCode 的新持久路径首先使用受控文件工具和 Skill，Bash 必须在证明子进程不能读取 SDK 私有状态后才开放，不能沿用整 SDK 进程的宽文件授权冒充工具隔离。旧一次性路径不改变。若通用 Skill 任务因此缺少必要文件操作，须补齐受控能力并完成实际任务，不能用部分文件冒充通过。

## 能力与验收

共用角色设定与两个 SKILL.md 保持同一版本。原生 Skill 目录发现、正文读取、显式选择和自然触发分别验证；模型自主安排 Skill 执行顺序，无 guardian/critic/revision 工作流。

每家先核对现有授权，再完成：空会话不自动推理；至少三轮真实对话；实际 Skill 生成完整文件；继续 QA 或修改；关闭 App 后同原生 ID 续聊；公开历史不重复；原始 transcript 不变。授权变化必须失败并要求重新选择对应会话，不能把另一账号装进旧绑定。

本轮不升级供应商 SDK，不接录音/ANE，不做跨授权交接，不将未知请求自动重发。两个 Provider 必须独立验收，不用 Codex 的结果替代。

## 原生接入细节（实测更新）

- Kimi 的原生 ID 为 `session_<uuid>`，ZCode 为 `sess_<uuid>`。恢复时保存并原样使用完整 ID；不能给已有 ID 再加前缀。
- ZCode 新建是惰性草稿。用公开 `runtime.ensureSessionPersistedForExternalActivity` 落盘空会话，再关闭；此操作不发送用户消息或模型请求。原生 SDK 的关闭、重开、历史输入和 Skill 工具回路已在确定性传输下验证。
- Kimi SDK 的 `builtin_product_skills=false` 仍保留通用内置 `write-goal`。Alma 注册表只接受来自应用共享目录的两份 Skill，文件身份必须一致；模型发起其他 Skill 调用由同一工具准入拒绝。SDK 的内部目录仍可能列出该内置项，这不等于 Alma 支持其功能。本轮不为隐藏该内置项修改冻结 SDK。
- 两家模型／推理强度从现有授权检查返回的目录取值，并与冻结适配器支持范围取交集；UI 选择传入实际 SDK 配置。
- SDK 的持久目录是 private controller 下的子目录，避免对授权根重复递归 mkdir 时触发只读父目录检查；业务权限不因此扩大。

持续模式不能沿用一次性调用的 1 MiB 请求正文门槛，否则会先于原生上下文窗口阻断正常长对话。新 session 模式的请求正文／guest 帧预算为 8 MiB／20 MiB；旧调用仍是 1 MiB／2 MiB。上下文压缩仍由各 SDK 负责，宿主不截断历史或自动重发。

## 完整转写复制

实际 ZCode 长任务在写出审查占位报告后，模型请求反复收到约 300 秒的 HTTP 524。旧验收曾因手机 SSE 断流采用非流式模式，当前不能仅凭超时就撤销该设置。持续模式先补齐原流程已有的“直接复制原件再编辑”的能力：两个 SDK 通过公开 MCP 接口加载同一个 Alma 文件工具实现，只提供 `copy_file` 和 `delete_file`。它不是新 Skill，不改变共享 Skill 文本或 SDK 版本；不开放 shell。

工具实现由 App 统一拥有，构建时作为各 guest 的只读运行资源打包，禁止在 session／授权目录生成实现副本。源文件仅限当前 workspace；所有修改仅限 assets，拒绝目录、路径越界和符号／硬链接。复制按块处理，单文件上限 32 MiB，临时文件放在目标文件同一目录，完成前取消不会替换目的文件。Skill 自行选择是否调用，宿主不预创建修订稿或调度审核。

Kimi 在会话创建／恢复时固定 MCP baseline。文件工具通过 SDK 支持的私有 home/mcp.json 在创建前登记，再等待 getMcpStartupMetrics，不能把连接成功误当成已经进入 Agent 工具表。开场必须核对实际 active tools 和只读共享 Skill 路径。

Kimi 的 `reloadSession()` 是重建原生会话，不是只读状态查询。静态策略检查改用 `getResumeState()`，仅新建后的首次检查需要 reload，并且必须在等待 MCP 就绪之前完成；之后通过 MCP readiness、原生模型请求里的实际工具表以及真实文件操作验收，不能因刚重建时的临时工具表缺项就误报。冻结 SDK 的本机测试已覆盖：打开不推理、同 ID 关闭重开、模型请求带两项文件工具、实际复制及删除。

真实 sealed iSH 文件系统回归已复现 scratch → assets 的 rename 返回 EXDEV。复制临时文件改为目标目录内的唯一隐藏文件，在同一挂载内原子替换；成功或正常取消后删除临时文件。硬终止后的清理属于后续异常恢复验收，不承诺已发生的 assets 修改自动回滚。

传输帧故障已由手机结构化诊断和真实 iSH 压力回归共同定位：非阻塞 stdout 上的 writeSync 遇到 EAGAIN，前一帧未写完，随后取消帧前缀拼入其中。两个 guest 改用同一 App-owned protocol-writer，按序使用 Node Writable 回调完成写入，HTTP 请求等待发送完成，终止前 flush；保留有界队列和独立日志通道。真实 iSH 对照中旧写法出现 EAGAIN，异步写法的两个大帧完整且顺序正确。

完整 Kimi 审查实际触发了旧单次任务模板的 max_steps_per_turn=64（原生 wire 记录 code=loop.max_steps_exceeded，恰好 64 次模型请求）。持续模式改用 SDK 的 0／不设步数上限语义，旧模式仍为64；原生单轮 HTTP 次数预算在持续模式为1024、旧模式仍为128，保留既有30分钟单轮时限及内存/并发/报文约束。失败通过已有原生错误分类器投影，不再只显示 incomplete；已完成的资产修改保持，并在同一原生 thread 中续作。

## 2026-11-17 参数与 ZCode 事件接线修正

- 模型/推理强度选择只校验当前授权已经取得的目录并保存到当前session；不加载SDK、不重新授权、不关闭/恢复thread、不触发推理。运行中仍禁止改变这一轮配置。
- 点击发送时锁定当轮参数；Codex随turn/start发送，Kimi/ZCode在既有每轮执行入口应用。保存失败必须保留原选择，UI等待保存时不得发送旧参数。
- ZCode以冻结3.17.2官方事件定义及旧TAH映射为依据，覆盖公开过程消息、工具生命周期、最终/部分回复、重试/排队、压缩、警告与结构化终止原因。
- 只转发真实公开文本，不合成发言或强迫调用Skill；不转发reasoning正文、模型原始请求、压缩摘要或凭据。
- queued继续显示running；maxConcurrency=1、modelStreaming=off、30分钟上限保持不变。
- 宿主仅在SDK与运行资源收尾后记录本轮终止；准备会话失败不把历史已完成轮次改为失败。
- 验收须覆盖：快速多次选择、无额外open/模型请求、下一轮真实参数及同thread；model_complete过程消息、重复/最终事件去重、空文本、错误/取消/压缩不误报完成。新官方事件必须在审计清单中明确归类，不能靠粗白名单静默遗漏。


## 2026-11-17 stable provider audit (build 37)

The user explicitly superseded the earlier SDK freeze for this round: adopt Codex 0.169.0, Kimi CLI 2.6.2 / SDK 0.23.1 and ZCode 3.18.2, retaining mobile ports, credentials and native session identities. The prior paragraphs describing a frozen SDK remain historical. Provider/account handoff and navigation are still deferred.

Inference selection is an Alma-local persisted setting; it does not open a provider runtime. The next admitted turn owns the selected model and effort. ZCode calls its official setModel after resume because resume restores the prior native selection; Kimi applies setModel/setThinking and verifies getStatus; Codex supplies model/effort on turn/start.

ZCode public tool-round model_complete content is commentary, not private reasoning. Its official event enum is exhaustively categorized in zcode-event-policy.json. Compaction/status events never replace the turn completion boundary. Kimi maps current tool.updated fields and actual skill.activated; its new executor retains serial mobile execution. A separate default-off mobile patch refreshes policy-filtered inline MCP schemas because the v2 loop snapshots tools before MCP registration. Skill orchestration and whether to speak before tools remain the Agent's decisions.

Queued tools continue to display running as requested. All providers reuse existing TAH working-event presentation and truncation. Upgrade verification is tracked in tools/mobile-tah/results/2026-11-17-provider-upgrade/audit.json; local passes are distinct from phone acceptance.
