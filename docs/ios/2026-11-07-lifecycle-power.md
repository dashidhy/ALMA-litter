# 当前包长文、后台与功耗验收

用户于 2026-11-07 重新授权需其参与的后台/锁屏、拔线功耗与 Kimi 长文重测。
这轮沿用手机已安装的 Alma TAH 0.4.1 (14)，暂不重建；此前测试驱动的
`needs_foreground` 分类补丁仍仅在源码中，未安装。主 App/其他 Session 不动。

证据根目录：`tools/mobile-tah/.cache/phone-lifecycle-power-20261107-avo7jyde`。
开始前 journal 已备份，419 条事件，SQLite integrity_check 为 ok。

## 当前验收状态

| 项目 | Kimi 2.4.1 | ZCode 3.17.2 |
| --- | --- | --- |
| 当前安装包 NVIDIA V0/V1/V2 | 通过，文件及旧记录核验通过 | 通过，文件及旧记录核验通过 |
| 拔线功耗 | 已记录，仅作粗略参考 | 已记录，仅作粗略参考 |
| 普通后台返回恢复 | 同一 V0 自动完成 | 同一 V0 自动完成 |
| 物理锁屏后恢复 | 同一 V0 自动重试后完成 | 同一 V0 自动恢复完成，含工具超时/重试记录 |
| 持续后台/锁屏执行 | 未建立保证 | 未建立保证 |

功耗测量误差不作为 blocker（用户已明确接受）。运行中状态不是通过，
后台恢复通过也不能替代持续后台执行能力。

## Kimi 版本范围

当前 Kimi runtime、compile-cache、trusted JS 哈希与 11 月 5 日完整 NVIDIA
测试包相同（2.4.1）；缓存/延迟加载不是本轮新加。当前 executable/native
identity 不同，因此重测是当前整包回归，也补齐此前未可靠落盘的长文功耗。
旧完整长文可作基线，不能由 11 月 7 日的短文回归替代当前长文验收。

## 采样准备

- 设备 iPhone 12 Pro / iOS 27.2，用户确认拔线并保持 App 前台、Wi-Fi/VPN。
- UI 确认 Kimi 已授权，复用 Keychain；没有再次输入 token。
- Device Hub Screen Sharing 已停止并核实 View Screen。
- 默认 Power Profiler 的 20s 预检含 1,891 条原始 CPU profiling sample，
  不应描述成无 CPU 采样。因此正式测试改用现存专用模板
  `AlmaW8Power20261020`，并添加 Thermal State。
- 专用模板预检能保存/导出，TOC 不含 time-sample/time-profile；原始模板
  已复制到证据目录，SHA-256 为
  `2881926476e2455027b00e5cd55c15419cbaa1bd0cd844527d1cf7632991a553`。
- xctrace 按进程名/PID attach 未找到目标；直接 launch 路径成功，未重置
  系统 DVT 服务或干扰其他 App。正式长文不附加 LLDB。
- Mac 观察器新增 power-template 和 max-minutes 参数，正式记录限 30 分钟。
  原生角色调度仍由手机 Core 执行，Mac 仅启动测试入口和读取报告。
- USB userspace 内存采样在拔线后报 usbmux device not found；单独记录采样
  缺口，功耗/功能测试不因它暂停。随后用 `--native` 复用 Apple 已存在的
  无线 remoted 连接，5 秒 App physFootprint 采样恢复，PID 2554；没有重启
  系统服务或创建接管式隧道。后台/锁屏资格测试前会停止此采样。

## Kimi 前台长文结果

Kimi NVIDIA：254 turn，中文，Web 开启，V0/V1/V2 同此前追加五点/精确改标题
规则。三轮全部完成，自动驱动 592.326 秒，23 次工具调用、0 失败。
全文导入、六次读回、V1 精确追加五点、V2 精确改标题、ASR 不变、
原 419 条事件保持均通过。V0/V1/V2 各 246.757 / 127.320 / 116.372 秒。
未充电、brightness 0.5（Instruments 为 51%）、Low Power Mode 关闭，
全部任务区间 thermal nominal。详见证据根目录 `kimi-summary.json`。

正式 trace 完整落盘并可导出，未包含 CPU profiling table。裁切到 Raw 开始
至最终结果读取，观测覆盖约 558.408 秒，整机估计 30.22%/h，积分约 4.69
个百分点。V0 Actor 为 24.88%/h；V1 Extra/Actor 为 43.24/29.80%/h；
V2 Extra/Actor 为 38.54/32.64%/h。以上是短窗口 Instruments 整机估计，
不是应用独占功耗或一小时实测。不能与旧包单独 Actor、不同仪器模板直接
归因为优化/退化；本轮默认模板预检的 CPU sample 混入问题已避免。
无线 App footprint 采样覆盖 V0 后段及后续修订，峰值 521.4 MiB；
不覆盖 Raw/初始加载，不含 WebKit。正式功耗、内存采样均已停止。

## 后台试验进展

短修订 V3 在用户退后台的确认到达前完成，实际 Home 时刻未知，判为时序
不确定，不能算后台通过/失败。V4 通过 Device Hub 实际 Home 页面验证
退后台，再停止共享；回前台前 journal 仍为 running。此为探索性记录。
用户随后要求改用更长的全新 NVIDIA V0，避免短修订交接窗口过短；
正式后台和物理锁屏将分别使用独立 V0。先让 V4 收尾，未中断或抹去旧结果。

独立后台 V0：action `b52eb8bf-5022-484d-9fe5-073ebcea8f42`。03:39:39Z
提交，03:40:51Z 在 CUA 实际观察到 Home，03:41:19Z 停止共享。
03:47:30Z 的后台 journal 仍 running，设备无需密码；03:48:07.806Z
请求将同一进程带回前台，03:55:19.966Z 完成。回前台后约 432.16 秒，
11 次工具调用、0 失败，两个发布文件 hash/长度有效，已有事件未改变。
结论是该窗口内未在后台发布、回前台恢复完成；无逐工具时间戳或 OS 挂起
trace，不能仅凭未完成就精确断定暂停点。该轮实际使用 Web，不能将其总时长
与此前工具路径不同的 246.757 秒 V0 直接作性能差值。证据：`kimi-bg-v0/result.json`。

物理锁屏 V0：action `918d9e69-dd34-4101-8973-1e87d1aa8066`，03:58:20Z
提交。用户按侧边键；04:01:13.800Z 系统首次确认 passcodeRequired=true，
04:06:56Z 锁定期间 journal 仍 running/无错误。用户随后解锁回 App；
04:10:29.246Z 系统首次确认无需密码，04:10:56Z 收到用户前台确认。
约 9 分钟的实际锁定观察独立于原定约 5 分钟窗口。04:15:55.705Z 同一
action/cycle 完成，原工作日志记录一次 APITimeoutError 后自动 retry attempt 2，
无需用户重新提交。系统解锁观测边界后约 326.46–336.91 秒完成；用户确认
前台不是精确解锁时间。7 次工具全部完成，Critic PASS；两个文件为
42,037 / 17,652 字节，hash/长度/UTF-8 校验通过，原 452 条事件不变。
此项是解锁恢复通过，不能据此认定持续锁屏执行通过。详见
`kimi-lock-v0/result.json`（23 项检查均通过）。

## 后续验收边界

1. 完成 Kimi 前台长文和实际文件/历史完整性检查，对齐功耗到 Raw/Actor/修订。
2. 后台/物理锁屏另开无 Instruments/无调试器场景，分别记录用户切换、
   后端可见进展、恢复时间与结果；不使用前台驱动的退出状态判断 Core 失败。
3. 当前 Tauri 测试包未编入主 App 的 AppLifecycleController，也无持续
   BGTask 注册/相关 plist 配置；先验证真实暂停/恢复行为，不承诺持续运行。
4. 随后 ZCode 功耗另测；整机估计不得当成 App 独占能耗或一小时实际掉电。
5. 每次用户需输入/锁屏/解锁前停止屏幕共享；不通过模拟进度或空转维持后台。

后台规则参考 Apple 的
[后台执行时限说明](https://developer.apple.com/documentation/uikit/extending-your-app-s-background-execution-time)
与[后台策略选择](https://developer.apple.com/documentation/BackgroundTasks/choosing-background-strategies-for-your-app)。
实际当前 App 行为以独立真机测试为准。

## ZCode 功耗准备

复用设备 Keychain 的既有 ZCode 授权，无新登录。已停止 Device Hub 共享。
独立 120 秒空闲记录热状态始终 Nominal；去掉前 30 秒后实际有效覆盖
91.725 秒，整机估计 7.543%/h。该值只作当前设备空闲参考，不能相减后
称为 App 独占功耗。专用模板 TOC 仍无 CPU sampling 表。旧 journal
454 条事件已备份供 ZCode 回归核对。当前无需重建或重新安装。

## ZCode 前台长文与功耗结果

GLM-5.3 / low，中文、Web 开启，完整 NVIDIA 254 turns。手机驱动
882.638 秒完成，V0/V1/V2 为 489.986 / 150.077 / 145.604 秒。六次
读回、全文、V1 精确追加五点、V2 精确改标题、ASR 不变、旧 454 条
事件保持、文件 hash/长度全部通过。35 次工具调用中一次 Edit 失败，
provider notice 明确允许继续；同轮自动恢复且最终发布通过，无手动重试。

功耗 trace 已保存、导出完成，专用模板无 CPU profiling 表，投屏关闭、
未充电、亮度 51%、Low Power Mode 关闭。Raw 至最终读回 851.036 秒，
整机估计 25.105%/h，积分 5.935 个百分点；V0 Actor 19.865%/h，
V1 Extra/Actor 40.038/26.644，V2 Extra/Actor 38.374/29.511。末段由
Nominal 升到 Fair。179 个 5 秒 App footprint 样本峰值 613.456 MiB，
不含独立 WebKit、不是连续瞬时最大值。所有采样器已停止。

**测量限制：** 原生系统电量以约 5 个百分点档位变化，本轮约 75%→60%，
与 Instruments 积分约 5.94 点不一致。当前原因未确定，必须同时保留两项
观测；不能以仪器估计声称实际只掉了 5.94%，也不能将其直接宣称优于 Kimi。
完整证据见 `zcode-long/validation.json`、`power-analysis.json` 与
证据根目录的 `zcode-summary.json`。

用户进一步确认：功耗只需粗略参考。仪器估计与系统电量读数的差异保留原始
数据和条件即可，不列为 critical blocker，也不继续为该差异追查或阻塞
功能/后台验收。后续功耗优化另行安排。

## ZCode 独立后台 V0

action `e33afee9-d085-45c5-9cf3-34f40a19a87f`；04:47:47.897Z 从普通
UI 提交，04:48:57Z 第二次 Home 才实际生效（第一次仅激活窗口），
04:49:11.819Z 核实停止共享。无采样器/LLDB/自动 qualification driver。
GLM-5.3 / low；新 action 默认 Web=false，本轮验证模型请求、读写和
前后台恢复，不覆盖恢复后的 Web 工具。前台功耗三轮均 Web=true，
不得混同为同一配置。04:54:39.627Z 返回前快照仍 running、无错误，系统不需密码；
04:54:43.755Z 将同一进程带回前台，04:58:35.229Z 完成，约 231.474 秒。
474 条旧事件不变，两文件 59,711 / 7,420 字节 hash/长度/UTF-8 通过，
Critic PASS；11 次工具无失败，无 Provider notice/retry 记录。笔记语言为 en，
交互为 zh-CN。27 项验收通过，只证明后台返回恢复，不证明持续后台执行。
证据：`zcode-bg-v0/result.json`。

ZCode 功耗独立复算一致。任务内 Fair 合计 62.816 秒（7.38%），仅末段
V2，V0/V1 均 Nominal。电量差异仅记录，不是功能验收 blocker。

## ZCode 物理锁屏 V0

新 action `60a1864e-5e64-47e8-975c-73426997aa31`，05:02:16.913Z
从普通 UI 提交。已核对 GLM-5.3 / low、笔记与交互 zh-CN、Web=true。
05:03:05.234Z 关闭屏幕共享，无 profiler/内存采样/自动前台驱动，随后
请用户按侧边键锁屏。用户确认已按侧边键；05:04:22.536Z 系统首次观测 passcodeRequired=true。
05:09:33.529Z 解锁前仍 running，系统仍锁定；05:10:31.494Z 收到用户
前台确认并核实无需密码。05:28:26.862Z 同一 action/cycle 完成，确认
回前台后约 1075.368 秒，总墙钟 1568.978 秒。19 次工具中一次 WebFetch
`tool_timeout`，其后两次 WebSearch 成功；另有一次原因不明 Retrying
活动，不能把它或超时归因为锁屏。没有手动重试或新提交。

两文件 61,240 / 5,709 字节，hash/长度/UTF-8 通过，Critic PASS；
479 条旧事件不变，仅新增发布/终态。30 项检查通过，详见
`zcode-lock-v0/result.json`。该结论仍只覆盖解锁恢复，不证明锁屏持续运行。

用户离开前询问是否可充电，已明确告知：本轮所有拔线功耗采样均已结束，
剩余 ZCode 解锁恢复/文件核验可以充电。不能将后续恢复时段混入拔线功耗。

## 本轮收尾

当前包前台长文、两种后台/锁屏返回场景均已取得并验证终态。所有 observer、
Instruments 与内存采样已结束，Device Hub 共享关闭，手机已观察到充电。
无新安装/大型原生构建；既有可用候选与回退包保留。
结构化汇总：[测试结果](../../tools/mobile-tah/results/2026-11-07-lifecycle-power.json)。

后续 Codex 0.167 升级是独立验收，不能继承本页的 0.166 整包 PASS。
已按用户要求准备隔离源代码快照；若需新的 Codex 授权，先完成代码、
构建和无授权验证，不弹出登录/授权问题，待用户回来。
