# iPhone iSH 工具验证

2026-10-31，在用户连接的 iPhone 12 Pro / A14 / iOS 27.0.1 完成。
独立 bundle `com.alma.frontier.ish-tools`；测试后已卸载，Alma Preview 保留。
未接 ASR、Gemma 或 Codex 模型，没有使用任何账号/订阅。

## 测的是哪一层

使用 Litter Cargo.lock 固定的 `dnakov/litter-ish` commit
`4f783cd957b83de3019d6a843408d5bb3ff902c7`，调用其真实 `IshInstance::boot` 和
`run_oneshot_streaming`，包含 guest supervisor、IPC、进程返回和流式读取。
与 Litter 使用的底层嵌入 API 一致；外面是本实验的 C ABI / UIKit 壳。

这不是 Mac CLI 移植，也不是完整 `codex-mobile-client` / Litter App 的验收。
没有经过 Litter 的 Codex exec hook、原生 apply_patch 或 0.166 模型调用。
探针 Cargo.lock 与 Litter lock 中同名依赖版本核对无偏差；supervisor 使用同版源树中的锁。

## 结果

18项预期匹配：16项正常行为检查、2项预期负向对照（安装前无Python、sh不支持Bash数组）。
“负向对照通过”不代表该功能可用。

| 检查 | 结果/本轮耗时 |
|---|---|
| sed、替换、管道、here-doc、中文/空格文件名 | 通过 |
| guest命令退出码7、stderr输出 | 正确回传 |
| guest apk离线安装固定签名包 | 通过，约9.02秒 |
| Python全文JSON/Unicode/哈希/文件修改重读 | 通过，约3.79秒 |
| Python线程、子进程、stdin管道 | 通过，约3.84秒 |
| Node全文JSON/文件修改/rename/重读 | 通过，约1.38秒 |
| Node子进程/定时器 | 通过，约1.19秒 |
| 同一内核三轮Python→Node修改 | 通过，约15.89秒 |
| 完整结果文件 | 117262 bytes，与Mac同一预期SHA-256一致 |
| Bash数组 / sh数组 | Bash成功；sh返回语法错误及退出码2 |

输入是现有NVIDIA全文254条转写；文本处理核对117155 UTF-8 bytes、44661字符及哈希。
这里的“修改轮次”是确定性工具脚本，不是模型生成/修改Structured Note的V0/V1/V2。

全套约44.96秒，包含首次rootfs复制和安装包；测试壳采样峰值footprint **46.25 MiB**，
最后thermal state=nominal；未触发资源/超时保护。每100ms采样可能漏掉更短峰值。
不是完整Codex/ASR/Gemma内存，不与Mac的RSS直接相除比较；单轮测试不能代表所有延迟分布。

实测guest身份为Linux/aarch64。Node自动获得上游注入的`--jitless --no-lazy
--max-old-space-size=512`，WebAssembly为undefined。显式加参数一轮不是JIT开启对照。
未验证npm、任意Python扩展、工具网络、后台连续执行或完整手机产品流程。

[汇总](../results/2026-10-31-ish-iphone-tools.json)；
[原始报告](../results/iphone/8dd33d08-c5f0-4290-b3c9-f1fcf76a8e3e/report-8dd33d08-c5f0-4290-b3c9-f1fcf76a8e3e.json)；
[退出确认](../results/iphone/8dd33d08-c5f0-4290-b3c9-f1fcf76a8e3e/collection.json)。

## 构建与复现

先按上级README准备固定的iSH源码和APK缓存。需要现有项目Rust工具链、Xcode、XcodeGen、
Meson和Ninja，以及本机开发签名。`build.sh`不会安装或启动手机App。

```sh
bash tools/alma-ios-lab/ios_probe/build.sh
```

产物在 `.cache/DerivedData/Build/Products/Release-iphoneos/AlmaISHProbe.app`。
用devicectl将此独立App安装到明确选择的设备，再运行：

```sh
python3 tools/alma-ios-lab/ios_probe/run_phone.py --device <device-id>
```

`commands.json`固定复用已在Mac运行的命令；`prepare_payload.py`从现有fixture生成同样的
脚本/输入，不依赖旧的本机运行日志。重建plan已与本次手机使用的plan逐字节核对一致。
payload约42MiB；原始rootfs、APKs、转写正文和构建产物留在忽略目录，不进入Git。

构建没有修改上游运行时代码。仅通过局部工具包装器为rust-lld提供其已有LLVM动态库，
让上游build.rs的`xcode-select -p`查询使用完整Xcode路径；不更改系统的Xcode选择。
VDSO必须是非空ARM64 ELF；本次3056bytes，不能接受空占位构建。

测试App的180秒安装上限、60秒命令上限、600秒总上限、900MiB footprint保护和8GiB磁盘
保留线，仅约束此实验。退到后台会保存停止原因并结束测试。结果落盘后整个测试App退出；
这不是产品内反复销毁/重建内核的实现。采集器检查精确PID已退出，不保留其他进程清单。
