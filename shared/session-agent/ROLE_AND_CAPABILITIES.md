# 角色与功能设定

2026-11-16 用户确认的 TAH 框架能力。先沿用已有角色文字；不在本轮新增话题拒答规则。

## 归属与内容

权威定义是 App 级资源 `roles/role-and-capabilities.json`，包含稳定 ID、版本、名称和正文模板。
它由宿主管理，供所有 session 和 provider adapter 共用，不放进 workspace 或 assets，也不作为可选 Skill。
当前定义为 `alma-session-assistant` v1，名称“Alma 会话助手”。语言与原生 Skill 访问方式由上下文/adapter 填入。
Codex 的渲染结果与抽取前的中文、英文说明逐字一致；新增的是框架归属和传递接口，不是新的行为限制。

## 传递时机

- 创建或恢复原生上下文时，adapter 应用这份配置。
- 后续普通消息只传用户输入和可选 Skill，不再额外拼接角色说明。
- SDK 可以在上下文压缩/重建时恢复必要的指令；这不等于每个模型步骤新增一份相同说明。
- 生效上下文和缓存仍有相应成本，不承诺“设置一次后永远不占 token”。
- 本地 `native_role_request` 审计仅记录方法、是否含配置和哈希，不包含正文，也不送给模型。
  原生日志的配置快照里出现相同文字，不能直接当作模型上下文被重复追加的证据。

## Adapter 映射

| Provider | 本地投影 | 本轮接入程度 |
| --- | --- | --- |
| Codex | `developerInstructions`，仅用于 `thread/start` / `thread/resume` | 已接入现有单 Codex Session Agent；21 号版本真机续聊、重开验收通过 |
| Kimi | 私有 home 的 `SYSTEM.md` 配置内容；`${base_prompt}` 保留原生基座，再接 Alma 说明 | 映射函数与测试已准备；未接新版持续会话、未改旧 TAH 适配 |
| ZCode | `AgentRuntimeConfig.systemPrompt` 自定义正文 | 映射函数与测试已准备；未接新版持续会话、未改旧 TAH 适配 |

三者不是同一种原生语义：Kimi 会展开模板，ZCode 会替换默认行为正文而保留固定的厂商前缀。
因此配置哈希仅标识提交的配置文本，不等于三家完整模型输入的哈希。接入 Kimi/ZCode 时仍需验收各自
原生模板、工具指导和恢复行为，不能将本轮映射测试描述成三家已在手机上跑通。

## 实现

- `session_agent_role.rs`：加载应用资源、渲染共通说明和生成配置凭据。
- `session_agent_role_adapters.rs`：将共通说明映射到三家初始化接口/文件配置。
- `session_agent_runtime.rs`：当前 Codex adapter 的创建/恢复调用与请求形状记录。
- `SessionState.roleAndCapabilities`：记录实际采用的角色版本和配置哈希；不新增聊天消息。

角色文案后续可以通过 App 资源更新，无须为纯文案改动重编译原生 SDK。
“不回答无关问题”的范围与具体措辞，留待后续产品讨论。

## 21 号版本验收

2026-11-17，iPhone 12 Pro 沿用原授权和原 thread，完成两轮真实 Codex 问答，随后冷启动恢复。
宿主请求记录为 `thread/resume → turn/start → turn/start → thread/resume`；仅两次恢复请求包含
`developerInstructions`，两次普通消息均不含该配置。恢复时的配置哈希与抽取前中文说明完全一致。
对话由 23 条增至 27 条，冷启动前后消息逐项相同；原始 transcript 和三份成果文件哈希均未改变。

9 项存储/角色测试通过，包含中英文 Codex 文案逐字对照和三家原生配置映射测试。
另以全新测试 workspace 补测初始化：打开后聊天和 assets 均为空，仅 `thread/start` 传入角色配置；
第一次真实问答的 `turn/start` 不含该配置，Agent 正确说明 Alma 录音助手的职责。
测试结束已切回原 session，原 thread 和历史不变。证据见
[role-initial-context.json](../../tools/mobile-tah/results/2026-11-16-session-agent/role-initial-context.json)。
记录验证的是 Alma 到原生 SDK 的请求，不据此推断云端传输、缓存命中或 token 计费。
完整证据见 [role-and-capabilities.json](../../tools/mobile-tah/results/2026-11-16-session-agent/role-and-capabilities.json)。
