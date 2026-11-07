# 移动端 Provider release 跟进评估

2026-11-07。只读比较官方 release/tag 与现有 iOS fork；没有升级、切换开发
分支或运行新版本。此次 0.4.1 (14) 包继续固定 Codex 0.166.0、Kimi Code
2.4.1、ZCode 3.17.2，并合入此前 ZCode 修复及原生代理补丁。

## 建议

两项都值得纳入后续 release 跟进，但本次先不替换已验收基线。没有找到
要求当前 TAH 立即升级的协议、订阅准入或已复现故障依据。先完成当前
ZCode 真机验收，再独立迁移，可以保留明确的版本对照。后续优先评估
Codex 0.167 的长任务正确性收益；Kimi 2.5.2 按一次完整 SDK 迁移处理。
这是基于当前文本/文件/Web 用例的工程判断，不是宣称新版本不稳定。

| Provider | 当前固定 release commit | 评估目标 commit | 目标发布时间（北京时间） |
| --- | --- | --- | --- |
| Codex | `rust-v0.166.0` / `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856` | `rust-v0.167.0` / `086ccc833bc9cf01024ad2dd6af7dbd421b6bf9a` | 2026-11-06 09:40 |
| Kimi Code | `@moonshot-ai/kimi-code@2.4.1` / `2c73f3f50af4fa7f2540ca0d2e33b07a1408e3a7` | `@moonshot-ai/kimi-code@2.5.2` / `1c142a007c10e881602690def96057c23a2baa12` | 2026-11-06 15:48 |

## Codex 0.167.0

官方来源：[release](https://github.com/openai/codex/releases/tag/rust-v0.167.0)、
[完整版本比较](https://github.com/openai/codex/compare/rust-v0.166.0...rust-v0.167.0)。

- 直接有价值的是失败响应、缺失 usage 时的上下文估算修复，可改善长任务
  压缩时机；还有认证请求准备、standalone Web 权限/路由与搜索失败回传。
  [上下文修复](https://github.com/openai/codex/commit/7a030b97699b9fc7f997dd322a3926c03faaeb6c)、
  [Web 修复](https://github.com/openai/codex/commit/94d89c74d616c4b9dbaf08fae8265b60da599bff)。
- 新增 Code Mode 有界输出收集值得评估，但当前 iOS 的 `with_limits()` 仍
  使用 Client 模式；需适配 Server 模式才能获得对应收益。输出限额不是
  V8 heap 限额，也没有消除现有 iOS memory-sandbox 差异。
  [输出实现](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/code-mode-runtime/src/output/mod.rs)。
- 新增 app-server 通知及人工审批协议。当前 Adapter 严格处理通知，且
  初始化/线程回执校验固定 `0.166.0`，需要一起迁移。不得为了消化新增
  审批协议而改变当前 TAH 的权限或 never-ask 策略。
- 现有移植补丁涉及 33 个文件，其中 11 个与本次上游改动重叠。关闭路径
  新增 `disconnect.cancel()`，与本地 `connection_closed_with_report()`
  拆分重叠，需保留取消和 drain/quiescence 两方面的语义。
- Rust 与 V8 的声明版本未变（1.95.0 / 152.2.0）；主要外部包版本变化为
  `mio 1.2.0 → 1.2.4`，另有内部依赖扩展。Linux musl allocator 优化不能
  当作 iOS 功耗收益；实验性取消和系统代理开关也不会自动完成移动适配。

迁移风险中等。必须复核原生认证刷新/换账号、严格 feature/事件清单、
Web 开关、文件/patch 路由、取消关闭、V8 输出行为，并回归使用共享执行层
的 Kimi/ZCode。完成相同 NVIDIA V0/V1/V2 后再替换基线；性能另测。

## Kimi Code 2.5.2（累计 2.4.1 → 2.5.2）

官方来源：[2.5.2 release](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai/kimi-code%402.5.2)、
[2.5.0 release](https://github.com/MoonshotAI/kimi-code/releases/tag/%40moonshot-ai/kimi-code%402.5.0)、
[完整版本比较](https://github.com/MoonshotAI/kimi-code/compare/2c73f3f50af4fa7f2540ca0d2e33b07a1408e3a7...1c142a007c10e881602690def96057c23a2baa12)。

- SDK 从 0.22.0 升至 0.23.0，agent-core-v2 从 0.5.1 升至 0.6.0。LLM
  请求链与 runtime/environment 机制重构，独立 kosong 包移除；不能由
  包变少就推断手机加载变快。[environment 改动](https://github.com/MoonshotAI/kimi-code/commit/5f3ab5fac81e050fc2fa10787dd560655f377d16)。
- 错误模型增加明确的 `retryable` 与状态来源，有正确性收益。当前 Adapter
  的 `failures.ts` 尚不读取它，并把所有 429 判为可重试；升级时要保留
  上游“额度耗尽不可重试”的语义，不能仅替换 SDK。
  [错误修复](https://github.com/MoonshotAI/kimi-code/commit/02d2e8f3fc79b2ebf160d5aa132dac304608d34a)。
- SDK 增加 `prompt.completed(reason=failed)` 等映射；当前主要等待
  `turn.ended` 的 Adapter 要验证模型回合开始前的失败/阻断也能终止。
  不消费的服务端 REST/WS 删除不算当前进程内 SDK 的直接阻塞。
  [事件映射](https://github.com/MoonshotAI/kimi-code/blob/1c142a007c10e881602690def96057c23a2baa12/packages/node-sdk/src/v2/event-mapper.ts)。
- 2.5.2 的 MCP 工具重复声明、Web UI 修复，以及 SSH/Docker/environment
  等功能，对当前固定工具集、未启用 MCP 的移动 TAH 收益有限。
- 上游尚未吸收我们的配置权限补丁和完整串行工具生命周期补丁。两个补丁
  的文本上下文仍可定位，但需要重建哈希锁并重新验证 prepare/execute/
  finalize/事件发布的顺序，不能据补丁能套上就宣称行为通过。
- 没有发现取消每次独立进程初始化的改动。现有 SDK 和预编译缓存字节身份
  全部要重建；手机上的 Node 22.23.4/iSH、jitless 和网络兼容层必须复核。
  源码层面仍使用全局 fetch，有望复用 pipe-fetch，但未做新版运行验证。
- 日志磁盘满恢复及防止从工作目录解析 git/gh 的修复有价值，但不等于修复
  App SQLite journal 或移动原生桥。未找到要求本 TAH 立即升级的官方安全
  公告；这不构成对整个依赖树没有风险的保证。

迁移至少覆盖：SDK/缓存重建与回退、权限和串行工具、429/额度耗尽/5xx/
断流的错误映射、所有取消阶段、失败终止事件、文件捕获与关闭回执，以及
完整 Raw/V0/Extra/V1/V2 的发布和重开恢复。之后再测加载、内存与功耗。

## 执行边界

本次只 fetch 指定官方 tag 并读取 Git 对象，两个 fork 的开发分支和原有
未提交修改保持。未执行新版本、未升级 SDK、未改 release/source locks。
更高版本的上线结论必须由独立迁移和回归建立，不能继承旧版 PASS。
