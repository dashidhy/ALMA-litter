# 0.4.1 (14) 真机复验

用户已于 2026-11-07 重新开放手机，并批准按功能 → 锁屏/后台 → 延迟/功耗
的顺序执行。内存用低频采样贯穿测试；测量失败不阻塞功能验收。

最新补充：用户去休息，所有需要其操作的步骤（锁屏后解锁、拔线功耗、重新
授权等）留到用户回来。不为这些项目打断用户，也不因此停止其余独立测试。
本轮主动测试不锁屏、不要求拔线；遇到需要人工授权的 Provider 先跳过。

固定包：Alma TAH 0.4.1 (14)，Codex 0.166.0、Kimi Code 2.4.1、ZCode 3.17.2。
设备实读：iPhone 12 Pro，iOS 27.2。安装前 App 为 0.4.0 (13)。
本轮证据目录：`tools/mobile-tah/.cache/phone-qualification-20261107-7v720_f7`。

## 结果

本轮无需用户操作的主要功能复验已结束，手机任务、内存采样、屏幕共享均
已停止；手机 App 留在已完成的 NVIDIA V2 笔记页。没有新建大型构建，
后端与 Provider 固定版本未更改，也未做本轮功耗测量。

机器摘要：[`2026-11-07-phone-requalification.json`](../../tools/mobile-tah/results/2026-11-07-phone-requalification.json)。

- 已原位安装并正常启动 0.4.1 (14)，未卸载 App。
- 安装前复制 journal 与 WAL，并生成一致的 SQLite backup。
- 安装前 354 条事件在启动后逐条保持相同，SQLite integrity_check 为 ok。
- UI 实读 ZCode 已授权，原有 Keychain 授权恢复，无需重新登录。
- 在 iPhone Settings 确认 VPN 开启、Wi-Fi 连接、飞行模式开启；没有修改网络配置。
- DVT Sysmontap userspace 路径每 5 秒采样一次 App physFootprint，未使用
  native tunnel takeover 或 CPU 调用栈采样。只统计 AlmaTAHTauri 进程，
  不包含独立 WebKit 进程；采样峰值不能当作瞬时硬峰值。
- 正常 UI 短任务通过 Raw/V0，GLM-5.3-Flash/high、英文笔记、中文交互、
  Web 关闭；两种结果文件都可分别打开，Markdown 正常渲染。4 次 Edit
  工具失败被同轮恢复，最终正常发布，不能表述为零工具错误。
- NVIDIA 全文 254 turn、121,541 UTF-8 字节，SHA-256
  `abf7e3a1207902db21d70cdcf1f74704d2b7c1668b59a67df8804c0d80dda0f7`。
  实际 GLM-5.3/low、中文输出/交互、Web 开启，V0/V1/V2 全部发布。
  V0 约 10m29s，V1 139.670s，V2 145.471s；V1/V2 各含约 46 秒 Extra Guardian。
  V1 精确保留原文并追加五条要点，V2 仅替换指定标题，ASR 三版字节相同。
  55 项 canonical 检查通过，旧 363 条事件逐条不变。43 次工具调用中
  1 次 Edit 失败后恢复；5 次 WebSearch，尚无 WebFetch（另行补测）。
- NVIDIA V2 Notes、ASR 表、v0 历史 ASR 和 V2 完整执行记录已在正常 UI
  打开。此处只说明实际观察的阅读范围，不等同于六个版本文件全由 UI 读回。
- 长文自动观察器在 V0 运行时因 Control Center 打开，将 inactive 误报为
  `needs_user_unlocked` 并退出。设备实读无需密码，主助手通过 UI 收起
  Control Center 后同一 V0 正常完成，再通过正常 UI 提交 V1/V2。用户未参与。
  原报告保留，不能声称原自动驱动完整通过，也不能当作锁屏/后台验收。

## 本轮发现的测试边界

- 当前正常 UI/Swift controller 未暴露 `action.cancel` / `raw.cancel` 命令；
  Core runtime 有这些入口，但运行中 `authorization.canManage` 为 false，
  不能用切换 Provider 代替取消。取消的真机 UI 验收暂缺入口，不能记为通过。
- 短文联网修订已完成：GLM-5.3-Flash/high，WebSearch 一次 17.678s、
  WebFetch 一次 20.156s，均成功。原 V0 关闭 Web 且日志无 Web 调用。
  联网前后设置均通过正常 UI。提交的 canonical 指令与预期逐字一致。
  ASR 不变；新增 External reference 明确标成外部背景并带官方链接。
  模型同时更新了已有笔记中两句“未联网”说明。用户复核认为这是正常的
  一致性更新：这些说明不属于 transcript 内容，联网状态改变后应相应更新；
  “原文”的转述也容易混淆 transcript 与生成笔记。实际测试英文指令使用
  `Preserve all existing notes text`，机械 append-only 检查确实未通过，
  但不能据此认定模型误解或移植故障。按用户确认的产品语义，此联网场景
  验收通过，不列为输出质量缺陷。保留 `web-validation.json` 的原始字节
  差异与检查结果，验收裁定见汇总 JSON 的 `zcodeWeb.acceptanceReview`。
- 已通过正常 UI 从 ZCode 切换 Kimi、再切 Codex，均复用手机保存的凭据，
  无需用户输入。两者重启后的 phone-owned 短文 Raw/V0/V1/V2 均完成。
  Kimi 全程 359.686s，24 次工具调用、0 错误；Codex 全程 123.833s，
  10 次工具调用、0 错误。每个 Provider 各 62 项机器检查与 8 项短文事实
  复核通过，六次结果读回与 canonical 文件经渲染归一化后对应。Web 均关闭且
  无 Web 工具记录；12 的用户更正、14 的来源归属及其余事实保留。
- 正常重启后 Codex 授权自动恢复，本轮 ZCode NVIDIA V2 可从文稿库重新
  打开，55,377 字节笔记可正常渲染。此前 419 条事件逐条未变，SQLite
  integrity_check 为 ok；重启没有新增 TAH 操作。恢复入口是重新选择已保存
  文稿/会话，不声称自动回到上一次页面。

## 内存观测

| 功能场景 | App 进程采样峰值 |
| --- | ---: |
| ZCode NVIDIA 长文 Raw/V0/V1/V2 | 635.3 MiB |
| Kimi 短文 Raw/V0/V1/V2 | 503.5 MiB |
| Codex 短文 Raw/V0/V1/V2 | 57.5 MiB |

这是单轮功能测试的观察值，任务和模型不同，不是严格 Provider 性能基准。
不含独立 WebKit 进程，也不是瞬时硬峰值。Kimi/长文任务完成后 App footprint
分别回落到约 59/54–65 MiB；不能仅凭这一轮排除所有长期内存泄漏。
共保留 1,030 条采样，证据目录中的 `memory-summary.json` 标明时间窗和 PID。

## 本轮基础设施记录

短文 Mac 观察器首次读取到了上一轮无 `startedAt` 的历史 load-profile 报告，
解析抛错。只修正本机证据目录中的观察脚本：忽略缺少时间戳的旧报告，并
按本次 launch 时间过滤。以 resume 模式恢复观察，未重启或重提手机任务。
这与手机后端任务失败不同，保留首次 launch 日志与恢复后的观察报告。

收尾复核修正了 `TAHMobileQualification.swift` 的生命周期分类：受保护数据
仍可读但 App 不在 active 时报告 `needs_foreground`，不再误报解锁；同时
记录 applicationState、protectedDataAvailable 与独立的 foreground 标记。
只有受保护数据不可用才使用原来的解锁提示。测试驱动仍是 foreground-only，
退出观察不会取消/重试 Core，也不会自动续跑；这不是后台运行能力的修复。
Mac 回归 `python3 tools/mobile-tah/qualification_lifecycle_checks.py` 通过；
完整驱动与实际 controller sources 也在 iOS SDK/Swift 6 严格并发模式下
typecheck 通过。没有链接/安装新包，手机 0.4.1 (14) 仍使用原观察器，
本轮原始 `needs_user_unlocked` 报告未改写。此补丁留待下次测试包纳入。

## 剩余验收

1. 用户回来后，再分别在网络等待与工具执行阶段检查锁屏/后台。现有长文
   观察器要求 active；分类补丁已在 Mac 验证但未装机，后台资格测试还需
   独立观察后端生命周期，不能把观察退出当作后端退出。需要用户解锁的
   步骤不在其休息期间执行。
2. 冷却后的不充电功耗对照，等用户回来协调拔线。本轮充电数据不作功耗结论。
3. 取消：需先给当前原型接入已有 Core 取消入口，再做正常 UI 真机验收。
4. 人为断网/恢复尚未注入；通过 Settings 切网络会离开前台，和用户明确
   延后的生命周期场景混在一起，留到该轮一起测。VPN 开启的正常路径已通过。

## 存储与改动范围

本轮复用 0.4.1 (14)，未重新构建或改动产品后端。仅增加验收脚本/记录与
本文档，并修正测试驱动的状态分类。保留当前包和选定回退包各约 745 MiB，设备 native 构建缓存约
15.58 GiB；即时可用空间约 74 GiB。本轮不存在新增的废弃大型构建；
Time Machine、其他 Session 的构建与进程均未处理。

长任务与功耗测试关闭屏幕共享；用户输入/登录/解锁前也必须停止共享。
设备控制可使用 Device Hub。输入采用粘贴并核对内容，避免 IME 误输入。
不触碰其他 Session 的 App、任务或构建。其他驻留 App 是否影响资源测量
需记录，不能只凭驻留进程名认定在执行工作或擅自结束它们。
