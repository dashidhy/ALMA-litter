# iOS 移植实验与历史审查

当前三 Provider 的手机 TAH 构建、源码所有权和验收入口是
[tools/mobile-tah](../mobile-tah/README.md)。维护中的实现来自 sibling
`ALMA-codex`、`ALMA-kimi-code`、`ALMA-ZCode`，不会再从本实验目录或旧
Codex submodule 的未提交补丁构建产品后端。Kimi 原生回归统一使用
`ALMA-kimi-code/ios/tests/native/run.py`，重复的本地 harness 已退役。

下文保留2026-11-01及更早实验的原始结论；其中“当前”“尚未验收”均指
当时状态，不能代替现行指南和带版本的真机报告。保留的回归/准备工具仍需
各自明确的依赖输入；历史探针不作为当前手机包的功能验收入口。

## 历史：以 Codex 0.166.0 为目标的接入前审查

**实施位置已迁移：ALMA-litter / dev/ios。用户已确认实施清单，当前正在实现与验证。**
旧ALMA目录只保留跳转说明，重复review clone已删除。不要将下文历史审查轮的未测试说明
误读为最新状态：基础Codex工具链和小合成样本的TAH V0/V1/V2已通过手机执行验收；
长真实录音、实际Agent锁屏后台、手机自主调度和正式安全边界仍未验收。

**2026-11-01 最新结果：** [手机TAH验收摘要](results/2026-11-01-tah-phone-qualification.json)。
原Mac框架调度/验收/发布，手机每轮一个独立进程执行原生Codex0.166+iSH；模型推理使用用户
订阅服务。Raw Guardian→V0→Extra Guardian→V1→Extra Guardian→V2六轮均完成，三个版本有
实际publication receipt。V1算术修正、V2仅重命名标题、旧版本/原始输入保护均核验通过。
单轮手机观测12.092–21.734秒，合计95.925秒；含检查与轮间调度的观测跨度200.743秒。
最高每200ms采样App峰值45.03MiB。**这不是NVIDIA长文、完整手机App或后台耗电结论。**
详见 [复现控制端](tah_phone_controller/README.md)。原始账号用量/设备结果目录已加入忽略规则，
不应提交到Git；无明文凭证导出，没有提交或推送。

- [后台探针结果](background_probe/README.md)：持续工作28分46秒完成；静默等待与未知进度
  实验收到系统到期通知；实际锁屏尚未确认。测试App已卸载。
- [执行器真机测试](backend_phone_probe/README.md)：原 owned-job 路径7/7通过；
  解锁后，新增受限工作区与原生补丁的整链真机测试10/10通过，9.315秒、峰值46.19MiB。
- [Bash与日志回归](shell_regression/README.md)、[账号续期实现与验证](auth_refresh_regression/README.md)。
  旧[账号guard回归](auth_regression/README.md)保留为历史。
- 原生受限文件接口和整份补丁预检查已集成，实际apply-patch调用12/12回归通过。
  [固定原生工作区](../../patches/ish-native-workspace/README.md)的Mac真实iSH工具链回读通过。
- Codex0.166本地配置已完成完整iOS Rust静态库构建；真实UniFFI Swift接口已生成。
  [最小原生测试界面](local_agent_probe/README.md)独立于完整ALMA App；真实登录、同App凭证恢复、
  模型目录、工具/Web整链及小样本TAH版本流程已验证，完整App/长任务仍未验收。
- `prepare_runtime_rootfs.py` 可一次性生成固定Bash/Python/Node工具包并校验复用；未切换正式App资源。

源码审查基线核实于2026-10-31；方案更新于2026-11-01，Asia/Shanghai。移植目标固定为
当时核验的稳定版Codex 0.166.0，按问题的**可解决性**分档。当前目标是手机本地Codex
承载Alma Prototype的TAH / Structured Note，不是移植Litter全部外围功能。

**当前实施入口：[展开后的实施清单](IMPLEMENTATION_PLAN.md)。** 逐项列出问题、修法、
验收、角色权限及实施顺序。方案已确认；具体通过状态以上述证据及后续报告为准。
[首轮0.155.1审查](REVIEW_0_155_1.md)保留为历史。最新验收范围以上述结果为准；
没有修改全局CLI或Mac权限，没有提交或推送。

## Code Mode 判断更正（2026-11-01 真机证据）

**最新基础链路结果：** `results/2026-11-01-native-agent-tool-flow.json`。真实手机订阅模型
`gpt-6.1-sol` 完成一段71字节合成文本的Bash数组、Python读取/哈希、Node复核、原生补丁、
Web搜索/打开/查找与保存证据，37.343秒；三条命令均exit0，补丁1次，原始输入哈希、nonce、
文件内容已独立回读核验。App每200ms采样峰值71.44MiB。这是固定小任务，不是NVIDIA长文
或长文TAH。角色/V0/V1/V2小样本的后续结果见页首；锁屏后台及正式安全边界仍未完成。

登录、凭证恢复、8个模型的目录查询和真实模型回复已验证。最初的文件/Web任务曾报告
`code-mode host is disabled`，该轮没有实际命令、patch或Web事件，保留为失败记录。

0.163与0.166相关选择逻辑相同。Mac启动时默认选择进程级Code Mode provider，安装包
包含host；`native-profile`中的false在后续`thread/start`才应用，不能据此证明host不可用。
这解释了为何照抄线程开关到手机启动配置可能失败，但不声称已还原某次历史Mac调用轨迹。
详见 `results/code-mode-version-comparison.json` 和 `results/2026-11-01-model-tool-selectors.json`。

Code Mode现为M14必需运行层。官方进程内实现与受限Node路径仍在验证；单独iSH工具测试
通过不能代替这层验收。普通iOS V8独立探针不含账号/录音，配置差异和失败记录单独保存。

### 官方进程内执行器真机进展

`results/2026-11-01-native-code-mode-functional.json`：iPhone 12 Pro上9组固定合成用例全部
通过，包括异步工具调用、状态保存、yield/wait、不可捕获的exit、CPU循环取消、回调取消、
shutdown后拒绝新任务。运行部分0.173秒，整个探针0.204秒，采样峰值18.63MiB，进程已退出。
这是本地执行器开销，不是模型推理或完整Agent任务耗时。

采用固定Codex0.166运行器源码和同版本V8 fork、JIT Disabled、Apple extended virtual
addressing entitlement；未申请increased-memory-limit。Release链接通过。Debug导出所有符号
时会保留未使用的WebAssembly绑定而出现两个缺失符号；没有补空实现、允许未解析符号或修改
原生库。普通V8包**不具备上游桌面版V8 memory sandbox**，因此功能通过不等于安全等价。

真实Agent接入使用默认关闭的`alma-code-mode-probe`，不改变普通App构建。它复用官方
`InProcessCodeModeSession`，仍通过Core delegate调用受限文件/执行接口。iOS App边界和
工具权限不能代替V8原生内存漏洞隔离。当前仅做有时限、App内存保护的测试任务；正式启用、
逐isolate资源限制、完整TAH及长任务后台仍未验收。上游会忽略的heap限制在适配器中明确拒绝。

复现顺序：`prepare_codex.py`、`prepare_native_v8.py`、
`build_native_code_mode_probe.py --check`、`build_native_code_mode_probe.py`。V8源码必须先准备，
Cargo的固定path patch才可解析。脚本验证源码/原生库/绑定摘要，构建不自动安装或运行手机App。

首次真实模型任务（`results/2026-11-01-native-code-mode-first-model.json`）已发起2条命令和
2次Web调用，但两条命令均在spawn前被拒绝，补丁与证明文件未成功，不记为整链通过。
已定位并正在复测：Core在所有平台附加Windows默认Reconcile字段、环境变量排除规则，
被过严的适配检查拒绝；apply-patch准备阶段仍按`is_remote()`选择平台约束，漏掉了同进程
的受限执行后端。修复保留原本的文件/网络权限，未知字段仍拒绝，补丁执行继续经过原生
批量授权和文件范围检查。15项执行器生命周期契约回归通过，边界DTO/iSH仍是测试替身，
不能代替后续真实模型复测。

后续实际修正还包含显式`ignore_default_excludes=false`（上游默认true），并在初始化时
校验整份固定环境变量配置。最终run-c整链通过。run-b的Web证明实际上正确，原官方入口
跳转至`https://learn.chatgpt.com/docs/app-server`，已独立打开官网核对后更新验证器；原失败
报告保留，没有回改历史的通过状态。

## 当前范围（2026-11-01）

用户将锁屏/切后台长任务与纠错所需Web纳入P0，不再限定只验收前台。
[后台/Web评估](BACKGROUND_AND_WEB_REVIEW.md)保留调查依据；H2为当前待验证阻断项，Web为M9。

隔离经后续讨论已具体化为：iOS承担App外部边界，ALMA限制iSH挂载、原生文件访问和工具
网络，Agent工作副本与正式发布分离。拆为M10/M3/M12及生命周期项；不要求完整VM等价保证，
也不把设计路线当成已通过的隔离证明。正常工具能力仍需保留。

已验证基础工具可执行，下一步须经过完整Codex桥接，最后用Raw Guardian→V0→V1/V2
真实任务验收。安装成功、工具脚本成功与完整任务成功是不同证据层级。

### 默认工具包的实际盘点

已下载并核验 Makefile 固定的 `dnakov/litter-ish v0.1.2/fs.tar.gz`：3,878,270 bytes，
SHA-256 `70e7d8acc9520ca45d53821dd3ffab1035620156dda3e513e66013e848f6ba0a`。
读取归档路径与 apk 已安装包数据库；没有在 Mac 原生 shell 或手机里冒充运行 iSH 测试。

- 有 BusyBox 和对应 `sh`、`sed`、`awk`、`grep` 等基础命令。
- 默认包**没有 Python、Node/npm、Bash 或 ripgrep**；不是一个默认齐备的桌面工具环境。
- Litter 会把识别出的 bash/zsh shell wrapper 规范成 `sh -c`；需要验证语法/参数兼容，
  不能仅靠补一个 bash 文件就推断原命令行为完全一致。
- ARM64 iSH 文档报告过 Python/Node 等运行时测试，但报告主要来自 Linux host，且不能
  证明这个默认 rootfs 已安装了那些包，也不能代替 iPhone 12 上实际脚本结果。
- 现存 Mac 文档和打包代码明确提供 Node；保留的 workflow 验收 JSON 没有完整 shell
  命令轨迹，因此不把“在文档/测试夹具中出现过 Python”说成真实任务成功调用的证据。
  用户观测到的 sed/Python，以及已有 Node 能力均列入下一步兼容性测试。

下一步功能验收按三层推进：工具存在与版本 → 在同一 iSH 环境中执行文本读取、Unicode/JSON、
文件修改和重读脚本 → 让新版 Codex 实际完成 Structured Note V0/V1/V2。
不能只测 `--version`，不能用 Mac 原生 Python/Node 通过替代 iSH 测试，不能用“模型尝试过
但命令未找到”当成功。缺包先补包；运行失败再定位 syscall/运行时/命令适配；完整任务结果
才是这轮 P0 的通过依据。

[完整静态包清单](results/2026-10-31-rootfs-tools.json)。这不是 App Store IPA 的工具清单，
而是本仓库固定构建输入的核实结果。没有修改上游或手机环境。

### 同版 iSH 在 Mac 上的工具实测：已完成

**后续真机验证已完成**：iPhone 12 Pro上使用真实Rust嵌入API和guest supervisor，
同一组文本/文件/子进程用例通过，保留sh/Bash语法差异；详见
[手机验证](ios_probe/README.md)。这仍不是完整Codex或手机App链路验收。

现在已有我们自己的执行证据，不再仅依靠上游的 Linux-host 报告。固定 iSH commit
`4f783cd9…`，在 M2 Pro / macOS 27.0.1 编译 **同一 C 内核/ARM64解释器**的 host CLI，
源码逐文件对照归档保持未修改。没有运行 Litter Rust supervisor/exec hook，没有安装手机 App。

在原版 rootfs 的独立副本里，用 guest `apk add --no-network` 安装经锁定的 Python
3.12.16、Node 22.23.4、Bash 5.2.37 及依赖。30个下载包合计约34 MiB，guest安装后
41个包约98 MiB；未用 `--allow-untrusted`。程序报告的系统为 Linux/aarch64，
不是用 Mac 原生 Python/Node 替代测试。

| 覆盖内容 | 结果 |
|---|---|
| BusyBox sed 分段读取、原地替换、管道、awk、here-doc、引号/中文/emoji | 通过，读取结果逐字节核对 |
| Python 读完整 NVIDIA 转写、JSON、Unicode、正则、哈希、写文件/fsync/rename/重读 | 通过；254条、117155 UTF-8 bytes、44661字符的统计和哈希与宿主一致 |
| Python 线程、子进程及 stdin 管道 | 通过并正常退出 |
| Node fs/JSON/Unicode/哈希/修改/rename/重读、子进程、定时器 | 通过并正常退出 |
| 同一内核内连续3轮 Python→Node 修改 | 通过；最终117262 bytes文件与预期完整内容一致 |
| Bash 数组语法 | Bash下通过；sh下语法错误、退出码2，确认不能无条件互换 |

Node 的“无额外调用参数”测试也启用了上游 iSH 自动注入的 `--jitless --no-lazy
--max-old-space-size=512`；实测 `process.execArgv` 已确认，`WebAssembly` 为 undefined。
显式加参数的一轮不是一个独立的 JIT 开启对照。没有验证 npm、任意Python第三方扩展、
网络访问或全部Linux命令；Alpine/musl结果不能外推到glibc。

Python全文脚本单次约3.48秒，Node约1.11秒；包括host CLI启动与150ms轮询，短命令计时/
峰值采样较粗，不用于推断iPhone延迟。Python/Node所测进程采样RSS约29/68MiB量级，
不是完整Litter App内存，也不是iOS footprint。没有进行模型推理或生成真实Structured Note。

**结论：常用文本工具在这组固定配置上有功能可行性证据，可以继续到Litter桥接验证。**
仍需补齐工具包、处理强制`sh -c`带来的语法差异，再验证真正Codex任务与iPhone行为。
不要把本次工具回放称为0.166 Agent、native apply_patch路径或手机全链路已通过。

[汇总与限制](results/2026-10-31-ish-tool-compatibility.json)、
[全文测试](results/2026-10-31-ish-tools-full-text-v4.json)、
[固定APK清单](results/2026-10-31-ish-package-lock.json)。原始本机日志和内容保留在`.cache`。

复现（只使用项目缓存，不更改系统安装）：

```sh
python3 tools/alma-ios-lab/prepare_ish_host.py --fetch
python3 tools/alma-ios-lab/prepare_ish_packages.py
python3 tools/alma-ios-lab/test_ish_tools.py --phase base --run new-run
python3 tools/alma-ios-lab/test_ish_tools.py --phase install --run new-run
python3 tools/alma-ios-lab/test_ish_tools.py --phase tools --run new-run
```

`--run`须换未使用的名称；脚本拒绝覆盖旧报告。超时、RSS、日志大小和单文件大小都有
上限。VDSO必须是有效的非空ELF，不能接受构建脚本的空占位回退。
早期三项准备错误（CLI root路径、guest退出状态采集、安装文件大小上限）在汇总中保留，
修正后重新验证；不把测试器错误算作iSH兼容性故障，也不把宿主退出0误判为guest成功。

## 版本基线

| 对象 | 核实值 |
|---|---|
| Mac 已安装 CLI | **0.163.0**，保持不动 |
| GitHub 最新正式 release | **rust-v0.166.0**，非 prerelease |
| npm `@openai/codex` 的 latest | **0.166.0** |
| 发布时间 | 2026-10-29 19:47:53 UTC；北京时间 10 月 30 日 03:47:53 |
| 最新版源码 commit | `6ff1e1ca3b30fc8b914720681fcf5fe62e95f856` |
| Litter | 2.1.9，`366aefdd616f16b9efb6c888be6cfd916bda47d6` |
| Litter 依赖的旧 Codex | 0.155.1，`be2951ea34f0d295ed0becf97079f92fa5f6950e` |

主比较是 **Litter → 0.166.0**；0.155.1 只帮助识别移植改动来源，不再是接入目标。
不以未发布 main/alpha 代替最新稳定版。
[核查记录](results/2026-10-31-version-baseline.json)；
[官方 release](https://github.com/openai/codex/releases/tag/rust-v0.166.0)。

ALMA 升级至 0.163 的历史也已核对：旧适配器把 `deprecationNotice` 当成禁止的功能激活。
升级同时补充了提示、partial answer、恢复事件和新字段处理，并非只改版本号。
参见 [现有升级记录](../../../ALMA/docs/alma_tah_v4_macos_app_integration_design.md#codex-01630-upgrade)
及 `app/TAH/providers/codex/adapter/tests/upgrade-compatibility.test.ts`。本轮没有修改桌面代码。

## 最新版对照结果

对 0.166.0 干净源码逐一执行原补丁的 `git apply --check`，另按原顺序检查，失败项跳过后
继续测其余项。**两种检查均为 5 个直接通过、9 个不通过**。无宽松内容匹配或强制应用。
旧补丁覆盖 57 个去重路径，其中 48 个在上游发生内容变化，9 个未变。
这证明需要适配，不证明无法修，也不等于完整编译结果。

确认的实际接口变化：

1. `InProcessStartArgs` 新增 `embedded_network_policy`，启动经过新 policy/auth bootstrap。
   要按新流程绑定配置和网络策略，不能仅填 Default 就宣称等价。
2. `ThreadItem` 从 enum 变为包含 `ThreadItemPayload` 的 struct，并增加可选起止时间。
   Litter 仍有 7 个文件、27 处显式旧式 `upstream/proto::ThreadItem::...` 引用。
   这是 Rust 源码 API 变化；新 payload 用 `serde(flatten)`，不能说整个 JSON 协议都失效。
3. unified exec 请求改成 `PreparedExecCommand` 等结构，输出管理和进程生命周期已有变化。
   旧 iOS hook 不能只靠修改补丁行号迁移。
4. 最新 `external_auth.rs` 与旧基线字节相同，仍要求客户端在 10 秒内回答凭证续期请求。
   因此首轮发现的 Litter 续期应答缺失不会随上游升级自动消失。
5. 0.166 修复了 app-server 线程启动/关闭竞态、runtime 释放、resume/fork 权限及推理 token
   记账。应保留新上游的修复，不能为兼容旧桥接而恢复旧实现。

[补丁与接口检查结果](results/2026-10-31-codex-0166-compatibility.json)；
[关键源码及 TAH 配置指纹](results/2026-10-31-latest-contract-inventory.json)。

## 分档定义

- **High risk**：目前没有确定能满足既定要求的完整解决方案，需要先做架构/运行时验证。
- **Middle risk**：有问题，但存在具体可实施的修法；工作量可能不小。
- **Low risk**：相对当前 P0，暂时不修也不影响流程；须注明范围条件。

证据等级与风险等级独立。已复现 panic 可以是 middle；未解决的隔离设计可以是 high。
未做真机测试本身不让所有问题自动成为 high。

## H1 的范围调整：工作区隔离已有具体实施路线

历史H1要求完整保留Mac独立VM的隔离保证；当前目标是App内部正常工具调用的工作区权限。
可信宿主决定挂载，guest不能扩大范围；原生apply_patch与其他文件工具经过受限文件访问层；
Agent只写候选，ALMA校验后发布正式revision；工具网络与Provider网络分开。

对应 **M10（挂载/基底）+ M3（原生文件/路径）+ M12（网络）+ M2/M7（停止/清理/发布）**。
有具体实施入口，但尚未完成。边界测试覆盖链接、重挂载、已有句柄和原生访问旁路；不能仅
靠cwd、chmod或patch字符串过滤。同进程运行时漏洞/崩溃没有VM等价隔离保证；若实际发现
无法收敛的旁路，应带证据重新升High。详见[实施清单](IMPLEMENTATION_PLAN.md)。

## High risk（当前）

### H2：长 Agent 任务锁屏/后台完成的稳定方案尚未验证（2026-11-01 新增）

不再后置为 L4。Apple 的 `BGContinuedProcessingTask`（iOS 26+）提供明确候选路线，
默认支持 CPU 与网络，不能以旧 `beginBackgroundTask` 的短时行为断言无法实现。
但当前 Litter 未采用该 API。系统的进度/资源调度与 Agent 的长时间模型等待是否匹配，
以及锁屏后的文件、网络、进程状态能否连续推进，尚无完整验证方案通过的证据。
H2 的未知是这个产品要求能否稳定满足，而不是“增加一个 API 调用很难”。

先验证真实锁屏与切 App 场景、真实进度稀疏/长等待、停止与恢复，再用实际 Codex 长任务
验收；短工具测试和后台倒计时不能替代。来源、分层路线和验收条件见专项评估。

## Middle risk

以下为索引；[展开后的实施清单](IMPLEMENTATION_PLAN.md)包含详细修法与通过标准。

| ID | 具体问题 | 修复方向 | 关键验收 |
|---|---|---|---|
| M1 | 9/14补丁冲突，启动/消息/执行接口变化 | 逐项迁移必要补丁，适配0.166 Rust与Swift接口，保留新上游修复 | 真机启动、会话与模型通信；不止Mac编译 |
| M2 | 取消、超时、子进程、stdin、输出状态不完整 | 对接新版执行契约，管理进程树、env、deadline和输出背压，确认停止后回收 | 取消后停止新增写入，旧进程/句柄不污染下一任务 |
| M3 | guest与native文件视图及权限不同 | 统一映射；官方patch解析器事前检查全部目标，实际读写走受限ExecutorFileSystem | shell→native→shell一致；链接、移动、并发路径替换不越界 |
| M4 | 外部凭证续期缺应答，账号guard有错误 | 补登录/刷新/失败/登出，隔离凭证，验证锁屏访问 | 真实续期可继续；错误不挂死/串账号，不改用API Key计费 |
| M5 | 新旧事件兼容与关键消息丢失 | 适配通知、partial、retry、final、approval、cancel，重连对账 | 不误完成、不永久等待、不重复发布 |
| M6 | 中文/emoji按字节截断panic，正文进日志 | 移除正文预览，必要截断遵守UTF-8边界，记录元数据 | 中文边界回归通过，日志不含转写和凭证 |
| M7 | 中断恢复、正式发布和跨任务残留 | 串行attempt，工作副本，校验后发布，可恢复提交和状态对账 | 原始材料/旧版本不变，半成品不发布，无重复revision |
| M8 | 构建和升级不可控 | 锁commit/补丁/Cargo/APK，保存可复现命令和回归，逐版升级 | 干净缓存可复现，不改变用户全局CLI |
| M9 | Web注册/认证/事件可能在移植中遗漏 | 保留官方hosted与适用standalone扩展、live模式、正文与引用回传 | 搜索→打开→查找→引用→纠错落盘，并覆盖后台等待 |
| M10 | iSH挂载和工具目录不是完整权限边界 | 宿主控制挂载，封闭guest扩大访问入口，输入/工具基底只读，盘点原生映射旁路 | 正常工具可用，跨任务/数据库/基底越界尝试失败 |
| M11 | 默认缺包，Bash被改写成sh | 打包并复用已验证工具，修两处shell转换及模型可见环境 | 完整exec hook下脚本通过，首次安装和热启动分开计时 |
| M12 | guest网络不能靠旧配置假定受限 | 限制guest外网/宿主控制接口，保留必要IPC与原生模型/Web网络 | 子进程/socket不绕过，官方Web正常 |
| M13 | 小探针资源数不能代表完整App | 分阶段测准备/启动/模型/Web/工具/发布，控制内存/日志/磁盘，后测语音组合 | 长任务瓶颈可定位，反复执行无持续资源增长 |

Middle表示有具体实施路线，不是已完成。Code Mode功能阻断已解除，基础工具链和混合调度的
小样本TAH已通过；其发布加固、手机独立控制层和后台仍未完成。逐项当前进度见
[实施清单进度快照](IMPLEMENTATION_PLAN.md#当前进度快照2026-11-01重新核验)，不能把分档当成验收通过。

## Low risk（仅针对当前 P0）

| ID | 可暂缓项 | 不影响当前流程的条件 | 重新审查的触发条件 |
|---|---|---|---|
| L1 | 实时语音 handoff、生成式 UI、游戏、Watch/Android/TUI 等外围能力 | 只接 iOS 文本 Structured Note，不启用这些业务功能 | 将来启用时重审；导致目标 crate 不能编译的引用仍必须作为 M1 修复或编译期移除 |
| L2 | stdio MCP、插件进程能力 | 当前TAH不启用这些外围能力 | Code Mode不再归入本行，见新增M14与下方更正 |
| L3 | 远程 SSH/WS 重发幂等、Windows 路径、远端目录等 | 当前先测手机本地 Codex，没有执行 Mac 中转路径 | 接 Mac 中转时升 middle，测断线后重复请求 |
| L4（已撤销） | 原先暂缓的后台持续执行 | 2026-11-01 用户将其纳入 P0，现归 H2 | 不再以只测前台作为完整功能验收 |

原L2判断已更正：0.166的code_mode_host默认开启，provider在进程启动时选择，host可懒启动。
Mac ALMA的线程级false不等于禁用了已选择的provider。`codex-code-mode`仍只是宿主客户端；
实际JS执行还需要host/runtime。App-server可以在iOS编译并完成纯文本推理，但不能据此
认定工具执行已经可用。当前Code Mode问题归M14，详见本文开头的真机证据。

依据：`app/TAH/providers/codex/adapter/src/native-profile.ts:29`；
[0.166 features](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/features/src/lib.rs#L1241)；
[host 创建](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/core/src/thread_manager.rs#L640)。

## 原审查条目如何重新归类

| 旧项 | 新档位 | 原因 |
|---|---|---|
| R1 中文日志 panic | M6 | 后果严重但修法明确 |
| R2 续期缺应答 | M4 | 最新版同一协议，可接回完整应答链 |
| R3 命令生命周期 | M2 | 有进程接口可对接；必须重做而非平移旧补丁 |
| R4 TAH 隔离 | M10/M3/M12/M2/M7 | 工作区隔离路线已具体化；不要求VM等价保证，仍须边界验证 |
| R5 文件映射 | M3 | 同时统一字节视图与权限，不能只转换路径字符串 |
| R6 账号 guard | M4 | 布尔条件可修，保留小测试 |
| R7 正文日志 | M6 | 可移除；仅改 tracing 等级不足 |
| R8 事件丢失 | M5 | 有界通道/关键消息交付/重同步可实施 |
| R9 后台 | H2 + M7 | 2026-11-01 起锁屏/后台长任务属于 P0；系统调度可行性先验证，状态恢复仍需实现 |
| R10 远端重发 | L3 | 当前不用远程路径，未来启用不能忽略 |

## 补丁明细

| 原补丁 | 0.166.0 干净源码 |
|---|---|
| mobile-crypto-compat | 通过 |
| ios-exec-hook | 需适配 |
| thread-read-permissions | 需适配 |
| thread-list-fork-lineage | 需适配 |
| mobile-shell-snapshot-timeout | 通过 |
| remote-app-server-websocket-cap | 需适配 |
| absolute-path-cross-platform | 需适配 |
| android-installation-id-lock | 通过 |
| dynamic-tool-call-arguments-delta | 需适配 |
| approval-timestamps-serde-default | 通过 |
| realtime-webrtc-env-apikey | 需适配 |
| realtime-handoff-server-hint | 通过 |
| realtime-dynamic-tools | 需适配 |
| realtime-client-controlled-handoff | 需适配 |

0.166 release 中的 UTF-8 截断修复针对上游 rollout JSON，不能自动修复 Litter 自己的
`ish_exec.rs`；不能仅凭更新日志出现相似关键词关闭问题。

## 建议实施顺序

以[待审核实施清单](IMPLEMENTATION_PLAN.md)为准：先固定基线，用独立探针尽早验证后台
和文件边界，再完成0.166最小桥接、真实订阅与Web，随后验收完整TAH及长任务后台对照，
最后接语音和页面。后台小探针不必等待完整Codex升级；完整Web/TAH依赖桥接和账号。
工具真机基础测试不能替代上述验收；不同时移植L1/L2全套外围功能。

跟进策略：正式 release → 核对 npm/commit 并锁定 → 对照必要源码与 schema →
文件/取消/认证/事件/TAH 回归 → 通过后升级。保留回滚版本，但不把长期停留旧版本当解决方案。
“尽量跟进”不等于每次构建自动抓 latest。

## 复现与范围

`audit_upgrade.py` 对临时副本应用原补丁，不修上游，核对归档及解压后的每个文件。
0.166 归档 18,852,337 bytes，SHA-256：
`718c86dcd7104919f2820aa79db0fa0083b5f240aa16da704f43e4acf7b544e5`。

```sh
python3 tools/alma-ios-lab/audit_upgrade.py --output /tmp/alma-litter-0166-audit-new.json
```

前置是固定 Litter、0.155.1 和 0.166 源码缓存。首轮片段复现仍使用 `audit_local.py`，
不改名为新版整机测试。结果不覆盖旧证据。尚未完成完整Codex Rust/iOS构建、模型调用或
真实账号续期；后续独立iSH的Rust/iOS构建与真机测试见ios_probe，勿与完整Codex混淆。
原源码审查只增加源码归档；后续探针另有构建缓存，当前方案整理只改文档。
