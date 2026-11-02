# Codex 0.166 执行器真机验证

2026-11-01，iPhone 12 Pro / A14 / iOS 27.0.1。

直接编译生产 `ish_exec_backend.rs`，使用真实 Codex `ExecBackend` 接口、
owned-job iSH host/supervisor/kernel 和已锁定的 Bash/Python/Node 工具环境。
测试授权器只接受编译进程序的固定用例，不接受模型或用户命令。

首次真机结果：**7/7 通过，4.525 秒，峰值 App footprint 22.89 MiB**。
覆盖中文及 emoji、独立 stderr、stdin 回传、SIGINT、取消持续写入的进程、
快速退出、输出超限后的完整清理；最后核对 6 个执行租约均完成，无隔离待清理项。
测试自行退出，宿主未强杀。

- 汇总：`../results/2026-11-01-backend-phone-probe.json`
- 原始记录：`../results/iphone/cfaf3ab4-8251-4be7-94bf-81958544d9b7/`

这个耗时是固定执行器用例的总时间，不是模型推理、NVIDIA 文稿处理或完整 TAH 的耗时。
本轮没有账号授权、网络模型请求、生产工作区策略或锁屏测试。

2026-11-01 后续已完成 mode 4 受限原生工作区真机测试：**10/10 通过，9.315 秒，
完整采样峰值 46.19 MiB**。38 MiB 是该轮结束时占用，不是峰值。新增真实原生
`apply_patch` 修改与 shell 重读的一致性，以及 Python/Node 的共享目录读写。
结果见 `../results/2026-11-01-sealed-backend-phone.json`，run ID
`92c14c4a-dcde-4f15-a5f1-23507395b0c8`。测试自行退出，无强杀或残留测试进程。
此结果仍是固定合成用例，不代表真实模型任务、完整 TAH、后台或锁屏验收。

从仓库根目录复现：

```sh
bash tools/alma-ios-lab/backend_phone_probe/build.sh
DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer xcrun devicectl device install app \
  --device DEVICE_ID \
  tools/alma-ios-lab/backend_phone_probe/.cache/DerivedData/Build/Products/Release-iphoneos/AlmaBackendProbe.app
python3 tools/alma-ios-lab/backend_phone_probe/run_phone.py --device DEVICE_ID
```

手机需保持此测试 App 前台。测试壳有内存、温度、磁盘和时间上限；离开前台会终止。
`run_phone.py` 收集报告并确认该次启动的测试进程已退出。不要把这个前台测试壳当作后台方案。
