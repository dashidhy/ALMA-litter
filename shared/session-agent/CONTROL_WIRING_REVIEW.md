# Session Agent 界面接线复核

2026-11-17，0.5.0 (22)。本次检查现有控件的真实调用链，未改运行代码、SDK 或模型策略。
此前 UI 交付验证了版式和基础操作，没有单独验收模型切换后的原生推理；本次补齐这项证据。

| 界面操作 | 实际处理 | 验证方式 |
| --- | --- | --- |
| 模型选择 | `agent.configure` → Swift 注入现有授权 → Rust 重开同一 thread → 原生 `thread/resume` / `turn/start` 使用选中模型 | 组件 change 事件测试；真机两模型请求；原生 `turn_context` 核对 |
| 推理强度 | `agent.configure({effort})`，保留当前 model；选模型时采用该目录项默认 effort | 组件事件/回读测试；真机 medium、low 推理配置及冷重开 |
| 发送、流式消息、工作过程 | `agent.send` / `agent.events` → 原生 turn 和事件归一化 | 本次两轮真实请求、既有流式验收及回归测试 |
| 停止 | `agent.cancel` → 原生 `turn/interrupt` | 本次控件调用测试；既有真实工具运行中取消记录，后端未改 |
| Skill 菜单、斜杠选择、清除选择 | 选择仅维护本地草稿；发送时转为原生 Skill 输入 | 本次回归套件；既有显式/自然语言 Skill 真机验收 |
| 原转写、成果列表和阅读 | `agent.assets` / `agent.read`，使用当前 session 工作区 | 本次调用链/控件测试；既有真机资源读取及用户返回跳转验收 |
| 文档内链 | 归一化业务路径后 `agent.read` | 相对链接、路径边界、阅读返回回归测试；既有用户真机确认 |
| 文档外链 | `openExternal` → Swift 校验 HTTP(S) URL → `UIApplication.open` | 路由测试及代码核对；本轮未在手机打开外站 |
| 顶部与输入区设置入口 | 打开同一设置页 | 组件测试 |
| 阅读主题、气泡样式 | 共用旧 TAH 的本地偏好；主题同步 `tah_theme` | 共用实现核对、既有主题/对话样式测试 |
| 收起键盘 | 保持 pointer 焦点后调用 textarea `blur`，不发送消息 | 组件测试、上一轮 WebKit 触摸布局检查 |
| 返回首页/重开 | `agent.leave` 映射 `agent.close`，释放运行时但保留原生会话 | 调用链核对；本次多次切换/冷重开保留同一 thread |

独立测试 workspace 的两条已完成请求：GPT-6-Astra / medium，GPT-6.1-Sol / low。
原生 rollout 内两条 `turn_context` 的模型、effort、turn ID 与完成消息逐项一致；不是模型自报身份。
冷重开保留 GPT-6.1-Sol / low 和全部消息。同一 thread 支持切换模型，未创建替代 thread。

已切回用户 workspace，保留用户刚选的 GPT-6-Astra / xhigh，消息数仍为 0。
前端 207 项测试和 TypeScript 检查通过。完整记录：
`tools/mobile-tah/results/2026-11-17-session-agent-ui/control-wiring-review.json`。

范围仍是单 Codex Session Agent。旧 TAH 的 provider/账号切换、Web 开关与 context-window 选择器
未移植到该入口，也未显示成不可用的空控件；联网按既定方案默认开启。
