# Alma TAH 第二个 Provider 接入审查

2026-11-03 更新。Kimi Code 已接入 ALMA-litter 的 Tauri 手机原型，沿用
TAH Framework → Provider Adapter → Provider Backend 边界。原始源码审查以
`fe444683` 为基线，下述实现与测试来自后续集成工作区。

当前 owned-policy Mac 文件工具测试通过。手机导出的 journal 和 native diagnostics
已核验 Raw Guardian、V0–V3 publication 与 critic PASS。V2 WebSearch 通过，
TensorFlow FetchURL 被服务端安全审核拒绝。V3 PyTorch FetchURL 已在手机完成，
发布的 External Reference 含 DeepLabV3、FCN、LRASPP。手机核心集成验收通过。[脱敏结果 JSON](../mobile-tah/results/2026-11-03-kimi-phone.json)
实现清单、故障定位、固定产物与复现入口见
[2026-11-03 Kimi integration evidence](../../docs/ios/2026-11-03-kimi-integration.md)。

## 版本与源码

本轮审查选定的最新正式 release 为 `@moonshot-ai/kimi-code@2.4.1`，发布于
`2026-10-30T09:50:16Z`。本记录和复现固定使用该 release。

| 项目 | 固定值 |
| --- | --- |
| 源码 commit | `2c73f3f50af4fa7f2540ca0d2e33b07a1408e3a7` |
| SDK | `@moonshot-ai/kimi-code-sdk@0.22.0` |
| SDK entry SHA-256 | `a85fa13949e2b3fb9bbf08a143d122123598ecac778e97d40716cde2b1e97e78` |
| permission-rules 补丁 SHA-256 | `a73d4c08efbdb59dbb732e3adc51eec83d31f27d12c8eca6a737872b3cfb9e02` |
| iSH guest Node | `22.23.4` |

SDK 使用上游锁文件和构建配置生成，permission-rules 补丁保留 ask 规则及审批语义。
源码、工具链、产物闭包和 release/main 差异均记录在
[latest-source.lock.json](latest-source.lock.json)。`Environment` 扩展属于之后的
main，锁定的 2.4.1 release 使用其实际已有接口。

Mac Adapter 的受控移入由 `shared/tah-runtime/kimi-source-lock.json`、
`kimi-upstream/` 和 `platform/kimi/adaptation.patch` 记录。SDK release lock 与
Adapter adoption lock 分别约束各自输入。

## 已实现的 App 接线

| 部分 | 当前实现 | 验证范围 |
| --- | --- | --- |
| Framework | 原 TAH Core 负责 Raw/Extra Guardian、Actor、Critic、修订、验收和发布 | 手机 V0–V3 publication、completed operation 和 critic PASS 已核验 |
| 注册与配置 | `entry.ts` 注册 Kimi，生成配置包含 Codex/Kimi profiles | 本仓库受控源码和资源生成 |
| 账号与设置 | 原生 Kimi key 输入、Keychain、credential handle，Provider 选择和 replacement/confirmation 接线 | 导出鉴权元数据为 valid，Raw Guardian 真实调用完成 |
| Mobile Adapter | `platform/kimi/mobile-provider.ts` 检查 frozen input，驱动 prepare/start/nextEvent/close/capture/release | Raw Guardian 手机闭环与 Mac owned guest 工具测试 |
| Guest Adapter | `platform/kimi/guest/` 使用真实 SDK Harness/session，保留 native tool 审批和 normalized event 转换 | Read、Glob、Grep、Write、Edit 合成模型驱动测试 |
| Native Backend | `kimi_backend.rs` 管理 owned process、管道、原生 HTTP 和终止结果 | owned closure、exit metadata、HTTP ACK 和完成后清理 |
| 网络 | guest direct network 被拒绝，Rust broker 约束模型路由和冻结 Web 能力 | 真实手机 Raw、WebSearch 与 PyTorch FetchURL 通过 |
| 工作区 | `provider_scope.rs` 复用 sealed iSH、只读材料、scratch 和 Actor 输出根授权 | 原始 grant 下真实文件工具通过 |
| 打包 | `prepare_kimi_runtime.py`、`prepare_kimi_rootfs.py` 和 `prepare_kimi_icu.py` 固定资源及兼容转换 | 已生成并用于已验证的手机包 |

真实 key 由原生平台和 Rust broker 持有。可信 JSCore 使用 opaque handle，guest
配置及请求使用 placeholder key，由原生 broker 为允许的请求注入真实认证。
关闭凭据包括 runtime closed、HTTP tasks joined、events retained 和 scope quiescent，
Adapter 验证关闭后再捕获候选文件，随后释放 scope。

Guest Adapter 对 `session.close()` 和 `harness.close()` 分别执行独立的顺序尝试。
任一失败保留 cleanup failure，并优先于完成或取消，成功清理后才发出最终答案。
定向回归覆盖 session、harness、两者失败与完成/取消组合的六种情况，修复前失败，
修复后通过。`adopt_kimi.py` 已编码该接入差异并生成 adaptation.patch/json。
手机 V0/V1 使用修复前构建。最终日志已确认 12 组测试全部通过，清理加固后
Xcode 构建、安装与启动成功，随后 V2/V3 已发布，V3 手机 FetchURL 成功。
原生 owned termination 和 scope drain 继续作为资源释放条件。

## owned-policy 故障与兼容修复

手机最初在 SDK `index.mjs:117090:62` 的 `localeCompare` 处失败。Mac 的实际
Rust owned host 在同样 grant 下复现 `RangeError`，错误消息为
`Internal error. Icu error.`。ICU `.dat` 文件读取成功，但其 file-backed
`MAP_SHARED` 请求被 `workspace_fd.c::wp_mmap` 明确返回 `ENOTSUP`。
`LANG=C.UTF-8`、`LC_ALL=C.UTF-8`、`C` locale 和显式英文 collation 的对照均已检查。

生产打包现在将原有固定 ICU 数据嵌入 `libicudata.so.74.2`，通过 ELF private
mapping 加载。`kimi-tools/source-lock.json` 的 `icuEmbedding` 固定输入和输出
哈希，`rootfsBuildVersion=2` 使新 rootfs 获得独立 ID。SDK 文件本身保持其锁定哈希。

随后发现 native realpath 会调用 `readlink("/workspace")`，触发祖先目录上的
`WP_READ` 检查。Node callback realpath 使用该环境支持的逐级路径解析。
Guest entry 在 SDK import 前设置 `fs.promises.realpath = promisify(fs.realpath)`，
再调用 `syncBuiltinESMExports()`。两个修复均通过原有 kernel policy 和 grant。

ICU 数据库的 ABI、原始字节、工具版本、可复现命令和 realpath 允许/拒绝对照见
[owned probe report](../alma-ios-lab/kimi_owned_probe/RESULTS.md)。

## 当前证据

| 环境 | 完成内容 | 结果 |
| --- | --- | --- |
| Mac Rust owned-policy，合成 HTTP | Raw Guardian Read → Glob → Grep | 4 个模型请求，13 个事件，38.6 秒 |
| Mac Rust owned-policy，合成 HTTP | Actor Read → Glob → Grep → Write → Read → Edit → Read | 8 个模型请求，25 个事件，39.4 秒 |
| 手机真实 API，本地 diagnostics/journal | Raw Guardian，`09:37:27Z` 至 `09:38:17Z` | safety allowed，close/capture/release 完成 |
| 手机真实 API，本地 journal | V0，UI 78 秒，`kimi-for-coding / low`，Web 关闭 | publication 与 critic PASS 已核验 |
| 手机真实 API，本地 journal/diagnostics | V1，UI 2m18s，Guardian `09:46:53Z` 至 `09:47:42Z` | publication、critic PASS、12 张图像修正已核验 |
| 手机真实 API，本地 journal | V2，166.164 秒，Web 开启 | publication PASS，critic PASS，WebSearch PASS |
| 手机 FetchURL + 独立 host service probe | TensorFlow tutorial，两次工具失败，host 返回 403 `websearch_audit_failed` | PROVIDER_BLOCKED，保留服务端限制记录 |
| 手机 V3 FetchURL | low，Web=true，PyTorch tool 8 completed，137.177 秒 | publication PASS，critic PASS，手机 FetchURL PASS |

上述时间均为 2026-11-03。两项 owned-policy 测试验证工具结果进入后续请求、
原始材料完整性、Actor 输出逐字节一致、连续事件序号、private home 删除、
`end_turn`、guest exit 0 和 owned closure。峰值单进程 RSS 低于 730 MiB。
工具测试使用已生成的真实资源包及合成响应。

V0 action 为 `3a92da08-200d-4585-8b65-d7b18dd989af`，交互语言 `zh-CN`，
action 语言 `en`，`Web=false`。V0 和 V1 publication 分别保存在
`tools/mobile-tah/.cache/kimi-phone-v0-journal/tah.sqlite3` 与
`tools/mobile-tah/.cache/kimi-phone-v1-journal/tah.sqlite3`。两个导出数据库只读
完整性检查均为 ok，pending 为 0，V1 的 accepted revision 为 1。已解码核对
publication 文件的字节数及 SHA-256，notes 总数为 12，ASR 文件字节一致。
V1 提交前通过
Device Hub **Edit → Send Clipboard** 输入并核对原文。最初硬件键盘输入受中文
IME 影响的内容仅停留在未提交草稿。剪贴板写入、Send Clipboard、实际字段核对、
提交需要顺序执行。具体输入原文及操作步骤见
[手机输入复现步骤](../mobile-tah/README.md#device-hub-text-entry-for-phone-qualification)。

## 历史 Mac C-host 实验

此前 `release-241-live-05` 在 unrestricted Mac C-host 上通过真实调用，三次模型
请求均为 HTTP 200，Read/Write 成功，244-byte Markdown 包含 Alice、Bob、Friday、
Thursday 和 500，完成事件、session/harness 关闭、guest 退出及 broker drain 通过。
该轮耗时 60.06 秒，其中 SDK import 18.96 秒。

live-01/02 未发出模型请求，live-03/04 在响应消费确认上超时。`pipe-host.py`
为 Mac C-host 提供 POSIX 管道后完成传输实验。手机生产后端使用 Rust owned pipes。
本次新增 owned-policy probe 已直接覆盖该 host crate、grant 和 guest entry 路径。

## 完成范围、限制与复现入口

四个 journal 导出中，原始 127 条 event row 的所有列均逐字节相同。
V0/V1/V2/V3 导出分别为 147/151/159/163 行，pending 为 0，完整性检查为 ok。
V3 导出为 `tools/mobile-tah/.cache/kimi-phone-v3-journal/tah.sqlite3`。其 Guardian
60.486 秒、Actor 76.484 秒，最终 diagnostics 中两者均完成 close/capture/release。
V3 外部参考小节以外的文本与 V2 字节一致，保留 12 张图像及其他转录事实。
Codex cached auth 的导出状态为 valid，18:22 上海时间 UI 已打开旧 NVIDIA V0/V1。
Kimi cached reconnect 的导出状态为 valid，checkedAt 为 `10:24:41.203Z`。
跨 Provider 新生成未测试。

最终手机生成 Xcode 输入和已构建 App 的 runtime manifest 均为
`8440bebe8469d691df56ed989551cf3453dd72413c8dafb6667146e808c38ae0`，
878 个 runtime 文件均与 manifest 哈希一致。此前 Mac owned-policy 工具测试仍对应
`aace22419d604cb313d36d8115c1ad96d71707edb83a13429db9ee8335f013f6`。
两个证据范围分别保留在结果 JSON 中，并记录最终可执行文件和链接输入的哈希。

手机核心流程、真实 WebSearch/FetchURL、publication 与数据保留验收已完成。
长转录、长推理、后台/锁屏和功耗未测试，跨 Provider 新生成仍未测试。
Host probes 中 example.com、PyTorch 和 Wikipedia 均返回 200，TensorFlow 返回
403 `websearch_audit_failed`。2.4.1 的云端优先 fetch 失败后进入本地 fallback，
DNS 拒绝掩盖了原始服务端错误。继续保持 service-only 网络边界。
本轮短 UTF-8 材料测试的范围为真实文件工具与协议闭环。Read 的长文截断及后续
分块读取仍需独立材料验证。

构建顺序和测试命令集中在
[mobile TAH README](../mobile-tah/README.md#kimi-provider-integration-2026-11-03)
与 [integration evidence](../../docs/ios/2026-11-03-kimi-integration.md)。
