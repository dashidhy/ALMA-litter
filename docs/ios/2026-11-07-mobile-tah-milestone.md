# 三 Provider 手机 TAH 里程碑整理

当前维护入口是[手机 TAH 指南](../../tools/mobile-tah/README.md)。四个仓库的
`dev/ios`已经归并已验收候选；只做本地提交，没有推送。主 ALMA/Mac App
源码不在本次修改范围。手机仍运行原先通过验收的0.4.2(15)，本次未重装。

## 固定版本与范围

| 仓库 | 当前版本 | Provider整理提交 |
| --- | --- | --- |
| ALMA-codex | 官方0.167.0 release加iOS适配 | `2f2f9536a2` |
| ALMA-kimi-code | Kimi Code2.4.1 / SDK0.22.0 | `9a2eb4242` |
| ALMA-ZCode | ZCode3.17.2 | `dd2144d3` |
| ALMA-litter | Alma TAH0.4.2(15) | 包含本记录的整理提交 |

保持 `TAH Framework → Provider Adapter → Provider Backend`。已验收范围为
当前Structured Notes用例、长文和多轮revision；后台/锁屏结论限定为回到
前台后同任务恢复完成，不保证持续后台执行或杀进程恢复。
完整证据见[升级报告](2026-11-07-codex-0167-upgrade.md)、
[Codex恢复补测](2026-11-07-codex-0167-lifecycle.md)及
[0.4.1的Kimi/ZCode功耗与恢复记录](2026-11-07-lifecycle-power.md)。

## 清理内容

- 删除App目录中15份不再被`lib.rs`编译的同名后端Rust副本；模块继续从维护中
  的fork加载。受影响的保留回归脚本改为读取fork中的真实实现。
- 退役重复Kimi native harness，统一使用`ALMA-kimi-code/ios/tests/native/run.py`。
  退役5个早期C-host研究入口及旧补丁提案生成器；历史报告和Git源码历史保留。
- 删除ZCode两个过期交接/状态文档和无当前调用者的Mac网络研究探针。
- 清除旧Codex submodule的本地重复补丁：逐文件确认等同于已保存的0.166
  fork提交后恢复其官方检出状态。当前TAH从独立ALMA-codex fork构建。
- README统一现行构建入口；旧版数据保持版本和日期，不把历史PASS改标成新包。
  前端复用备忘继续保留。

兼容包、rootfs工具、Kimi编译缓存、ZCode已验收runtime及仍有消费者的回归
输入保留。目录名称含`mac`、`probe`或`.cache`不自动代表可删除。

## 构建与证据保留

移除旧原生target、旧0.4.0回退包、Xcode中间目录、临时JSCore基准目录及
重复Kimi测试target，再加本轮验证结束后移除的测试编译产物，合计约19.3GiB
的目录占用。即时可用空间另行记录，
不能把目录体积当作APFS实际释放量；没有删除或缩减Time Machine快照。

- 当前签名包：`tools/mobile-tah/.cache/codex-0167-upgrade-20261107/candidate/AlmaTAHTauri.app`。
- 唯一选定回退：`tools/mobile-tah/.cache/candidates/0.4.1-14/AlmaTAHTauri.app`。
- 当前原生库、冻结源工作树、绑定、依赖输入及完整真机证据保留在已验收实验目录。
  签名、原生来源与三个Provider资源身份已重新校验。

清理没有修改运行时实现或Provider版本；冻结安装包没有重新编译。
干净检出重建必须遵守来源检查，不能绕过原生输入变更检查后直接复用旧库。

## 本轮检查

- Codex来源清单、18项迁移约束、11项协议检查通过。
- Kimi131项SDK/适配器/串行/缓存检查、59项native契约检查通过。
- App来源清单、TypeScript、bundle、3个Provider按需加载检查通过。
- TAH三轮六文件回放、Codex/Kimi六轮十二文件回放、后台分类检查通过。
- 24项执行器边界契约检查、15项scoped-files host检查及iOS模块编译通过。
- 绑定输入指纹的5项回归通过，覆盖三个Provider的修改、新增/删除及缺失。
  原夹具只建立了Codex/Kimi，导致ZCode目录缺失；本轮补齐第三Provider夹具，
  未放宽实际构建脚本的来源检查。
- 前端TypeScript及194项测试通过。ZCode全仓typecheck、lint及架构检查通过；
  lint保留86条warning、0error，没有自动修改无关代码。
- 四仓干净源码检出通过9项来源、类型和构建检查。JSCore核心、三个Provider
  包、前端dist均与真机已验收产物逐字节一致。显式共享了匹配锁文件的npm及
  ZCode工作区依赖缓存；这不是从零联网安装全部依赖或全量原生重建。
- Kimi首次测试因缺少显式`TAH_RUNTIME`参数未启动完整套件；补齐后全部通过。
  native测试首次缺少`CARGO`路径，选择既有工具链后通过。既有工具链的
  `rust-objcopy`缺少libLLVM导致strip warning，测试仍实际执行通过，未改全局工具链。
- 干净App类型检查首次缺少ZCode工作区类型依赖；补齐相同版本依赖缓存后通过，
  指南已明确安装顺序。检查器最初把显式依赖软链接也算作源码脏状态，随后只
  允许那三条已核实目标的链接，所有tracked源码保持不变。

本轮不重新调用模型，也不重新做完整App原生构建或真机回归。最终整理的
机器记录见[清理结果](../../tools/mobile-tah/results/2026-11-07-milestone-cleanup.json)。
