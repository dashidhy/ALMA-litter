# Alma 手机版前端集成备忘

更新日期：2026-11-02。当前基线：`dev/ios`，TAH 测试 App `0.2.0 (5)`。

这里集中记录手机测试中已经做过的前端修正，供之后把录音、转写、自动标题与摘要、Agent Task 接成完整 App 时复用。整合前先读本页，再按代码索引迁移组件和原生配套；不要只凭截图重写一遍。

当前可复用的是独立 Tauri + React TAH 前端。它与完整 Alma Preview 的拼接尚未完成；下表中的“已验证”也不代表整个集成 App 已验收。业务边界继续遵循 Mac 版的 **TAH Framework → Provider Adapter → Provider backend**，UI 改动不重写这三层。

## 当前动效决定（2026-11-02，替代此前低动态方案）

用户真机反馈：抽屉的淡出／不可见复位／淡入像低帧率刷新或频闪，体验比原滑动更差。**当前 App 自有前端不再读取或监听系统“减少动态效果”状态，也不保留对应 CSS 媒体分支。** 抽屉统一连续滑动关闭／回弹，loading 统一持续旋转；删除呼吸式 loading 和淡入淡出替代路径。

不修改用户系统设置；系统键盘、OAuth 等系统界面的行为仍由 iOS 决定。“减少透明度”是另一项独立设置，本次不改。必要状态文字、文件读取和请求等待提示保留。下文的低动态模式实验是历史记录，不能作为现行实现重新引入；任何再次适配必须先经用户重新确认，不能仅凭自动测试通过认定视觉舒适性合格。

## 已确认的交互和修正

| 编号 | 问题或设计决定 | 集成时保留什么 | 当前证据 |
| --- | --- | --- | --- |
| UI-01 | 测试页需要沿用 Alma Preview 的风格 | Tauri + React；Ink／Paper 两种外观、统一颜色变量、紧凑顶栏、44 px 主要触控目标；阅读页与设置／记录库分开 | 真机及浏览器验证 |
| UI-02 | Markdown 源码直接显示，笔记不可读 | 标题、段落、粗体、列表、链接、表格、代码块；保留原始 Markdown，由展示层渲染；宽表和代码块各自横向滚动，页面本身不横向撑开 | SAM 真机阅读；代码块与窄屏由前端测试／浏览器覆盖 |
| UI-03 | Read ASR terms 曾打开 Notes | Notes、ASR terms、Transcript 使用不同材料请求；带上 action、revision 和文件身份，确认新返回材料与请求匹配后再切标签，不能把旧正文换个标签冒充新结果 | SAM 真机验证独立文件、ASR 表格及原文 |
| UI-04 | reasoning 选项被显示成整句说明 | 显示 provider catalog 的标准 handle，并提交同一个 handle；例如 `low`、`medium`、`high`、`xhigh`、`max`、`ultra`。这组是当时模型的实际选项，不能写成所有模型通用的硬编码列表 | 真机菜单验证 |
| UI-05 | 首次点输入框时被键盘遮挡，第二次表现不同 | 用实际 visual viewport 高度／偏移布局；首次 focus、收起、重开、输入法高度变化都要跟踪；不能仅用 `100dvh` 或固定键盘高度 | 真机首次输入、重开、搜狗九宫格／英文全键盘切换 |
| UI-06 | 输入区像一条嵌在正文中的底栏，层次不清 | 输入框、模型入口、收起键盘和发送按钮放在同一个浮动圆角卡片里；左右留白、轻阴影、细描边，正文在其后独立滚动；去掉全宽顶部分隔线 | 用户给出 ChatGPT 手机截图作为层次参考；当前实现已装机验证，视觉仍可微调 |
| UI-07 | 键盘上方多出半透明的上一个／下一个／完成辅助栏 | 用 Tauri 的正式 accessory hook 关闭该栏；在卡片现有按钮行保留小型收起键盘入口，不另加一条工具栏 | 真机确认移除与收起行为 |
| UI-08 | Paper 模式在键盘上方露黑边 | Web 页面颜色与原生 WKWebView／宿主底色一起切换；键盘出现时不再重复保留 home indicator 的底部安全区 | 真机 Paper 模式验证 |
| UI-09 | 草稿、设置异步返回可能覆盖新编辑，阅读可能拿到旧材料 | 复用现有 controller 的序列化、editor 身份检查、返回结果校验和草稿合并逻辑；不要在新页面另建一套乐观业务状态 | 前端回归测试；键盘实测中输入／清除字符不丢焦点、不发送 |
| UI-10 | SwiftUI 测试壳原位更新成 Tauri 后曾黑屏 | 保留 App 数据容器与 Keychain；遇到该特定迁移问题先排查旧 scene restoration，而不是卸载 App 或删除笔记库 | 备份并清除旧 UI 恢复缓存后恢复；数据库逐项比对通过 |
| UI-11 | Settings 顶部有拖动条，却不能下滑收起；Alma Preview 已做过的手势在新壳遗漏 | 所有共用 Sheet 都复用 Preview 的下拉关闭逻辑；头部可拖，内容区从顶部开始下拉才接管，短拉回弹，操作输入框／选择器不误关闭 | 旧 Preview 算法已迁移，18 项手势检查通过；Settings 和 Working Events 的真机头部下拉关闭已验证；记录库复用同组件 |
| UI-12 | 抽屉标题像带绿色边框的按钮 | 标题保留 h2、aria-labelledby 和初始辅助功能焦点，但仅对静态 sheet heading 去掉 outline；关闭按钮与真正控件继续保留 focus-visible 提示 | 根因是 `[tabindex]:focus-visible` 命中程序聚焦的 h2；共用样式已修复装机，记录库标题真机确认无框。Settings／Working Events 同用此样式，最终包的单独复看因 Device Hub 窗口操作失败未完成 |
| UI-13 | 用户／Agent 消息缺乏区分，完成后仍有多余的执行摘要 | 默认双侧气泡，Settings 可切轻气泡并记忆；版本在消息内；运行中最近 3 条公开事件，完成后直接进入完整日志 | 原生角色投影与完整日志接入；真机历史 SAM、合成测试修订均验证 |
| UI-14 | 手动上翻执行记录后被下一次刷新拉回末尾 | 内容区 pointer/touch 开始时即暂停跟随，不能等延迟的原生 scroll；实际回到底部或点 Latest events 才恢复 | 真机 SAM v0 上翻停留和 Latest events 返回末尾已验证；新增对应回归 |
| UI-15 | Raw Guardian 等 loading 圈静止 | 所有忙碌提示复用旋转 `.spinner` 和状态文字；按 2026-11-02 最新决定，移除 reduced-motion CSS 分支与呼吸动画 | 原因确认是旧分支关闭动画；此前呼吸方案已被用户最新决定取代 |
| UI-16 | 低动态抽屉淡出／复位方案被用户反馈为频闪、不适 | 删除系统状态查询及淡出变体，统一连续位移关闭／回弹；直接拖动仍跟手 | 系统偏好开启时也验证位移、全程不隐藏面板；回调和卸载安全检查保留 |
| UI-17 | 忙碌状态没有 phase 时只剩圈；文件读取、请求确认前只有禁用控件 | 未知忙碌显示 Processing／Preparing；文件读取给明确文字；原生命令确认前显示按操作命名的 pending 提示，在打开的 Sheet 内也可见 | 共用 loading 样式；异步读取／确认前等待的回归检查，不伪造模型执行进度 |
| UI-18 | Settings 收起后主页面闪动 | 设置修改时保存；关闭不保存，不插入 Saving draft、不禁用整页；自动保存继续串行排队并报告错误。遮罩在滑动期间同步渐退，焦点恢复不滚动正文 | 回归先复现了 Saving draft 插入；修复后覆盖无变更关闭、变更时保存、后续操作排队、新编辑保留与失败反馈 |
| UI-19 | 模型菜单同时显示对外名称与内部模型编号，重复且拥挤 | 通用 provider 规则：用户展示使用 catalog 的 displayName／Choice.title；选择、保存、请求始终使用原 handle／modelID。名称不附加编号；名称缺失或为空时回退到原模型 ID，不从编号猜名字 | Settings、输入卡片入口及历史版本配置展示统一；模型请求与保存值不变 |

| UI-20 | NVIDIA 运行时 Progressing 旋转、事件刷新与完整日志滚动卡顿 | 必须量测手机本机 FPS 与主线程，不能只改 spinner 样式；业务 JSCore 不应与 UI 争用主线程。保留正在运行的用户任务 | 本机连续动画采样 2–7 FPS；宿主约 75.5% CPU、WebContent 约 1%；主线程栈集中于 JSCore 回调和状态投影。已装机；独立 NVIDIA 全流程完成。运行中三段共 90 个采样为 58–60 FPS、中位数 59；完整日志加载／浏览已验证，手指滚动手感仍以用户实测为准 |

## 键盘和浮动输入卡片一起迁移

这部分需要同时带走 Web 布局与原生设置，单独复制 CSS 不完整。

1. `viewport.ts` 取 layout／visual viewport 可用高度的交集，处理偏移和顶层 dialog 的底部位置。如果原生视图已经缩小，不再减一次键盘高度。
2. `useViewport` 在根容器挂载时订阅 resize／scroll／focus 变化。首次 focus／blur 后还会用有界的 900 ms 帧循环跟随动画，避免第一轮 viewport 事件到得晚；恢复全高度时清除残留 offset。卸载时释放监听、帧回调与样式状态。
3. 输入卡片浮在 `work-area` 上；`useComposerInset` 用 ResizeObserver 测量实际高度，给正文末尾预留滚动空间，最后一条消息仍能滚到卡片上方。
4. 当前样式基线为左右 12 px 留白、20 px 圆角、键盘上方 8 px 间距。键盘出现时 `--bottom-inset` 为 0；这些是可微调的视觉参数，不能替代实际键盘高度计算。
5. 原生窗口创建时使用 `with_input_accessory_view_builder(|_| None)`；`tah_theme` 同时更新 WKWebView 底色与原生外观。不要用修改 WebKit 私有类的方式实现。
6. 收起按钮位于已有控件行，只做 blur，不修改输入内容、不提交任务。键盘与卡片移动时，发送按钮和输入正文都应保持可见。

磨砂目前是 CSS `backdrop-filter`，不是苹果原生 `UIGlassEffect`。已有不支持模糊时的不透明回退和减少透明度样式。用户认可的是“正文在后、输入卡片与键盘在前”的层次方向；是否接真正的 Liquid Glass 仍是后续选择，不要把它记成已经实现。

## 阅读和设置不能丢掉的细节

Markdown 使用 `marked` + DOMPurify。用户指令和原始 Transcript 按纯文本保留空白；不能根据内容外观自行猜测它是 Markdown。当前正文不自动加载远程图片，链接只在用户点击后通过原生入口打开允许的 HTTP(S) 地址；这些行为需要随渲染组件一起迁移。

ASR Terms 的旧问题来自 SwiftUI `List` 同行默认按钮行为：两个按钮可能一起触发，第一个 Notes 请求占住读取入口。旧壳的 `.buttonStyle(.borderless)` 已保留作为修复。现在的 Tauri 阅读页另外校验材料 ID、action、版本和文件名称；两种修复属于不同层，不能只改链接文字。

模型和 reasoning 来自真实 catalog。笔记输出语言、Agent 交互语言、每轮 Web 设置各自独立；首次提交后的输出语言冻结由原始 TAH 状态决定。交互语言不等于整个 UI 已完成本地化，也不能用于改写历史结果的语言标签。

设置与输入草稿区分处理：模型／reasoning／Web／笔记语言通过 `editSettings` 在变更时提交到原生并执行持久化 checkpoint，交互语言也在变更请求中持久化；阅读外观和气泡样式在选择时写入版本化本地偏好。**Settings 关闭只收起面板，不触发保存。** 普通指令输入仍是 250 ms 防抖更新原生内存，提交／切换／满足条件的页面隐藏等时机 checkpoint，不能把每次按键都描述为已写盘。发送前先刷新草稿并检查 editor 身份；异步返回只覆盖尚未被用户更新的字段。进程被系统杀死时的完整草稿恢复仍需集成阶段验证。

## 直接复用的代码索引

以下路径都相对本仓库；共享逻辑应尽量直接迁移，平台相关代码按最终宿主适配。

| 用途 | 代码入口 |
| --- | --- |
| 前端根页面与浮动输入卡片 | [App.tsx](../../apps/ios/tah-ui/src/App.tsx)、[styles.css](../../apps/ios/tah-ui/src/styles.css) |
| 键盘几何与监听生命周期 | [viewport.ts](../../apps/ios/tah-ui/src/viewport.ts)、[useViewport.ts](../../apps/ios/tah-ui/src/useViewport.ts) |
| Markdown 与纯文本展示 | [Content.tsx](../../apps/ios/tah-ui/src/components/Content.tsx)、[markdown.ts](../../apps/ios/tah-ui/src/markdown.ts) |
| 独立阅读页与材料身份 | [Reader.tsx](../../apps/ios/tah-ui/src/components/Reader.tsx)、[material.ts](../../apps/ios/tah-ui/src/material.ts) |
| 设置、记录库与弹层 | [Settings.tsx](../../apps/ios/tah-ui/src/components/Settings.tsx)、[Library.tsx](../../apps/ios/tah-ui/src/components/Library.tsx)、[Sheet.tsx](../../apps/ios/tah-ui/src/components/Sheet.tsx) |
| 对话气泡与样式偏好 | [Conversation.tsx](../../apps/ios/tah-ui/src/components/Conversation.tsx)、[chatStyle.ts](../../apps/ios/tah-ui/src/chatStyle.ts) |
| 工作事件预览与完整记录 | [Working.tsx](../../apps/ios/tah-ui/src/components/Working.tsx)、[WorkingLogPanel.tsx](../../apps/ios/tah-ui/src/components/WorkingLogPanel.tsx)、[working.ts](../../apps/ios/tah-ui/src/working.ts) |
| 工作记录滚动跟随 | [useEventLogScroll.ts](../../apps/ios/tah-ui/src/useEventLogScroll.ts)、[event-log-scroll.ts](../../apps/ios/tah-ui/src/event-log-scroll.ts) |
| UI 状态和命令边界 | [controller.ts](../../apps/ios/tah-ui/src/controller.ts)、[contract.ts](../../apps/ios/tah-ui/src/contract.ts)、[bridge.ts](../../apps/ios/tah-ui/src/bridge.ts) |
| 原生表单辅助栏、主题背景 | [Tauri lib.rs](../../apps/ios/tah-ui/src-tauri/src/lib.rs) |
| 原生 presentation 与草稿 | [TAHWebPresentationBridge.swift](../../apps/ios/Sources/AlmaTAH/Runtime/TAHWebPresentationBridge.swift)、[TAHMobileController.swift](../../apps/ios/Sources/AlmaTAH/Runtime/TAHMobileController.swift) |
| 旧 SwiftUI 同行按钮修复 | [TAHHistoryView.swift](../../apps/ios/Sources/AlmaTAH/Presentation/TAHHistoryView.swift) |
| 可复用回归测试 | [前端测试目录](../../apps/ios/tah-ui/src/__tests__) |

接口的详细字段和前端构建见 [前端 README](../../apps/ios/tah-ui/README.md)。真机打包、单个 Rust 静态库、原位更新与旧 scene 缓存处理见 [mobile-tah README](../../tools/mobile-tah/README.md)。整合时不要把测试 bundle ID、签名团队、私有本机路径或 QA fixture 当成正式 App 配置直接照搬。

## 抽屉下拉关闭必须随组件一起复用

顶部拖动条代表可下拉交互，不能只复制视觉。Settings、记录库、Working Events 等共用 [Sheet.tsx](../../apps/ios/tah-ui/src/components/Sheet.tsx)，并同时带走 [sheet-gesture.ts](../../apps/ios/tah-ui/src/sheet-gesture.ts)、[useSheetDismiss.ts](../../apps/ios/tah-ui/src/useSheetDismiss.ts) 和 [手势样式](../../apps/ios/tah-ui/src/components/sheet-gesture.css)。这套逻辑直接来自参考仓库 `ALMA/Frontier/mobile/ui_preview`，避免再次重新设计。

- 拖动条及标题区域允许向下拖动；关闭按钮继续正常点击。
- 内容区只有在手势开始时所有祖先滚动容器都在顶部，才允许向下拉来关闭。在中途滚到顶部的同一次手势不会突然变成关闭操作。
- 输入框、选择器、按钮、链接等交互控件和正文选字不抢手势；横向、向上的手势不关闭抽屉。
- 足够长的下拉或明确的快速下甩关闭；短拉、取消和回拉恢复原位。关闭与回弹统一使用正常位移动画，不读取系统减少动态效果状态。
- 下拉、关闭按钮、Escape、点击遮罩走同一个关闭回调；Settings 只收起，不在此保存。焦点使用 preventScroll 返回，防止正文跳位。

回归用例：[手势算法](../../apps/ios/tah-ui/src/__tests__/sheet-gesture.test.ts)、[共用组件事件](../../apps/ios/tah-ui/src/__tests__/sheet-dismiss.test.tsx)。当前移植保留原 Preview 的阈值与手势所有权规则。2026-11-02 曾试用淡出与不可见复位，用户认为有频闪，已明确撤回。现统一关闭 180 ms、回弹 220 ms 的连续位移，直接拖动始终跟随手指。只有缺失 Web Animations API 的兼容环境才直接完成关闭／复位。

## 对话气泡与 Working Events 的已定方案

2026-11-01，用户手动完成了手机 TAH 的 V0 → V1，反馈操作流畅。随后选择了对话草稿的第二版。**以下已实现并安装到手机 Tauri 测试 App 0.2.0 (5)，不是仅有交互草稿。完整 Alma App 的拼接仍未完成。**

- 采用第二版“双侧气泡”：用户指令靠右，Agent 回复靠左，以位置、角色标记和不同底色明确区分。
- 第一版“轻气泡”已放入 Settings → Conversation style，选项为 Double bubbles／Lightweight，默认双侧气泡；选择以版本化本地偏好保存，原位更新和重启后仍保留。第三版“每个 revision 一个外框”明确放弃，后续不要重新引入。
- 去掉“V0 初稿／V1 修订”的额外横线与分段标题；气泡内部已有版本标签，保留该标签即可。
- 延续已实现的浮动输入卡片及键盘处理。

Working Events 对齐当前 Mac 版，按状态展示：

| 状态 | 对话里的展示 | 完整记录 |
| --- | --- | --- |
| Actor 正在执行 | 最近 **3 条经过公开事件过滤的事件预览**，默认展开、可收起；显示已用时和进行中提示。预览直接来自事件，不另调模型生成摘要 | 记录可读时提供完整事件入口 |
| 修订成功完成 `completed`／`published` | **不再保留事件预览或摘要折叠层**；完成耗时放在完成状态处，保留最终回复与产物入口 | 一次点击直接打开该轮完整执行事件；旧记录没有日志时不放空按钮，没有时间时不编造耗时 |
| 失败／取消等异常 | 不冒充“成功完成”；保留 Mac 已有诊断行为 | 后续按原事件和状态合同接入，不能套用成功状态把诊断删掉 |

完整事件查看器已保留 Mac 的阅读习惯：在底部时跟随新增事件；用户向上查看历史时暂停跟随；提供“最新事件”返回末尾。刷新不应让整个列表闪烁或跳位。日志受限、属于旧轮次或读取失败时保留原有提示。展示范围仍是公开事件，不暴露 Guardian 私有执行过程。

Mac 对照位置为参考仓库 `ALMA/app/desktop/src/Conversation.tsx` 的 `Message`、`CurrentActivity`、`Working` 和 `WorkingLogContents`；过滤规则见 `working.ts`，滚动行为见 `event-log-scroll.ts`。`Conversation.test.tsx` 已明确覆盖：成功完成用直接完整日志按钮替换预览、运行中只取最后 3 条、缺失日志／时间不伪造入口，以及失败后保留诊断。

当前通过显式角色／状态／版本字段投影气泡和 Working Events，不能根据显示文本中的 `You`、`TAH` 字样猜角色，也不能用当前的通用 Details 文本代替完整事件记录。接入沿用原 TAH 的事件来源和权限边界。

### 接入时实际发现并修复的问题

- 打开日志必须在第一次命令返回前同步发布新 loading 身份，再异步读取内容；否则前端拿到旧的空快照，会误报日志未打开。原生 `TAHMobileWorkingLogReader.open` 已修复，并覆盖 live／historical 首次 admission。
- 相同 action 在 publication 时 editor token 改变，不代表换了会话；已打开的日志不得因此卸载。切换 action／transcript 才清除阅读路由。
- 已加载日志刷新时不插入临时 loading 行；读取失败保留上次有效内容，并把“日志读取失败”和“Actor 仍执行中”分开。
- 手动查看历史的意图要在 pointer/touch 开始时锁定；尤其 Device Hub／触摸滚动可能先合成滚动、稍后才通知 scroll。事件末尾不能用过期的位置自动恢复跟随。
- 抽屉标题的初始 focus 是辅助功能定位，不代表按钮。不要全局关闭焦点框，也不要为消除框而删掉标题语义。只在共用 sheet heading 范围抑制视觉 outline。

## 集成时的复测清单

- [ ] 首次启动后第一次点输入框即可输入；文本与发送按钮不被键盘遮挡。
- [ ] 收起再打开、连续输入、候选词栏变化、九宫格／全键盘切换后位置正确；收起后页面恢复，无残留黑边或空洞。
- [ ] Settings、记录库、Working Events 顶部下拉可关闭；内容正常滚动、选词、调模型或点击链接不误关闭；短拉可回弹，重新打开后位置正确。
- [ ] 浮动输入卡片后面的正文可独立滚动，最后一条内容可完全露出；收起按钮不提交、不丢字。
- [ ] 系统减少动态效果开关不改变 App 自有 loading／抽屉表现；loading 始终旋转且有文字反馈；Raw Guardian、初始准备、材料读取、日志读取与 Progressing 使用同一规则，轮询不重置动画。
- [ ] Ink／Paper 下 WebView 原生底色一致；窄屏与较大字号下控件仍可操作。系统键盘及其他输入法另行真机验证。
- [ ] 同一版本的 Notes／ASR terms／Transcript 可反复切换，快速切换或读取失败时不误标旧内容；不同 revision 读取正确。
- [ ] 双侧气泡区分用户与 Agent；版本只在气泡内标注。运行中最多展示最近 3 条公开事件，成功完成后预览消失，完整事件可直接打开；向上读日志时不被强制拉回末尾。
- [ ] Markdown 标题、列表、宽表、长代码、链接正确；原始 Transcript 和用户指令保持字面文本。
- [ ] 切模型后的默认 reasoning 正确；旧响应不覆盖用户的新设置；语言冻结、Web 与发送权限仍由原 TAH 决定。
- [ ] 新建页面、阅读返回、路由切换、弹层和前后台恢复不重复注册 viewport 监听；草稿 checkpoint 与最终 App 生命周期接好。
- [ ] 升级安装前后转写和已发布版本不丢失；不要为处理 UI 缓存而卸载带用户数据的 App。

这份清单留给**最终集成 App**验收，不能因当前测试壳通过就自动打勾。

## 验证基线与后续维护

2026-11-01 的实体设备为 iPhone 12 Pro、iOS 27.0.1，键盘复测覆盖用户安装的搜狗中文九宫格和英文全键盘。截至 2026-11-02 前端已有 137 项测试通过；其他机型、系统键盘、横屏和辅助功能组合不在本次真机通过范围内。

- [Tauri 阅读与设置真机记录](../../tools/mobile-tah/results/2026-11-01-tauri-ui-acceptance.json)：含 Markdown、材料切换、reasoning 和 SwiftUI → Tauri 原位更新；当时 7 个发布版本保持不变。
- [键盘修复真机记录](../../tools/mobile-tah/results/2026-11-01-keyboard-layout.json)：含首次焦点、收起重开、输入法切换及测试字符清理；用户完成 SAM v1 后已有 8 个发布版本，更新前后 journal events／chunks 仍逐字节一致。

- [气泡、执行记录与抽屉验收](../../tools/mobile-tah/results/2026-11-01-chat-ui-acceptance.json)：前端 124 项检查、原生日志 26 项检查及原核心三轮多块日志回放；真机验证偏好持久化、完成后的完整日志、历史滚动与返回末尾、抽屉下拉。合成资格测试转写新增一个 v3；原有 8 个发布版本及其日志字节保持不变。真实运行已完成，但未在设备画面上捕获最近 3 条事件的运行中预览；这一点仅由组件／投影测试覆盖，不冒充真机目视验收。

测试截图属于本地 `.cache` 工件，可用于当时视觉对照；可迁移的决定、代码索引和验收条件都保存在本页，不依赖缓存永久存在。

后续发现前端小问题时，继续更新本页：为新项分配编号，记录用户期望、根因、修法、代码入口、验证环境与待验证范围。尚未实测的项标为待验证；被新决定取代的项写清替代关系。独立测试壳、Alma Preview 和最终集成 App 的验证状态分别维护。

### Loading 与减少动态效果（2026-11-01，历史方案，已被上方当前决定替代）

用户在 Raw Guardian 检查时发现静态圈。通过只读开发诊断确认手机 `REDUCE_MOTION = True`；旧 CSS 媒体分支将全部 `.spinner` 设置为 `animation: none`。修复只涉及共用动画：默认 `spin 1s`，低动态模式改为 `loading-pulse 1.8s ease-in-out infinite`，透明度在 0.45–1 间变化，不旋转或位移。原有状态文本、事件来源和忙碌状态判定不变。代码复查未发现普通快照轮询会不断重挂载圈的证据。

浏览器默认模式实际采样到不同旋转矩阵；低动态分支通过临时本地 fixture 强制媒体条件命中，五个使用场景均采样到同一呼吸动画。这是 CSS 分支验证，不声称重跑了五个真实 provider 任务。手机原位更新，系统减少动态效果保持原值。

验证记录：[Loading motion](../../tools/mobile-tah/results/2026-11-01-loading-motion.json)。真机授权检查的忙碌提示出现并在结束后消失；操作较短，未截到两帧明暗差异，持续动画由上述浏览器采样验证。


## 全 App 动态效果检查（2026-11-02，首次检查记录；动效分支已撤回）

**本节是首次检查的历史结论；用户随后否决了替代动效，当前以页首决定为准。** 当时原则：减少动态效果不等于把必要反馈减到零。 对“正在处理”“点击已接收”“面板正在关闭”等承担交互含义的动效，应选择低运动感的替代表现，并保留可读的状态文字；不能统一用 `animation: none` 或提前 `return` 抹掉反馈。也不能仅有一个循环动画，就暗示后端一定正常——完成、失败、等待和真实进度仍以原状态为准。

本轮范围按实际 `prepare_tauri_app.py` 的打包清单确认：完整 Tauri 前端、当前原生宿主与展示接口。旧 SwiftUI 测试壳及 Litter 原始 UI 不在这次安装包里；独立 Alma Preview 和最终 ASR／录音合并后的 App 仍按集成清单另行复测，不能用当前包的通过结果代替。

| 检查对象 | 普通模式 | 减少动态效果模式／检查结论 |
| --- | --- | --- |
| 初始准备、Raw／Extra Guardian、Actor、材料加载、完整日志 | 共用旋转圈及状态文字 | 共用低强度明暗呼吸；未知忙碌 phase 也保留文字兜底 |
| Settings／记录库／Working Events 的自动收起及拖动复位 | 原位移过渡 | 已把直接完成的分支改为短淡出／淡出后复位；回调只执行一次 |
| 手指拖动抽屉、内容滚动和横向表格 | 直接跟随手势 | 保留，属于操作反馈；不因系统偏好禁用 |
| 输入法避让和浮动输入卡片 | 测量 visual viewport 并跟随实际尺寸 | 保留；`requestAnimationFrame` 用来测量几何，不是可随意删掉的装饰动画 |
| 执行日志跟随和 Latest events | 底部跟随，上翻暂停，按钮返回末尾 | 保留真实滚动／事件更新；没有依赖动画回调才能刷新的逻辑 |
| Working Events 计时、完成／错误状态 | 真实时间与事件更新 | 不关闭计时和文字状态，不新增模型调用 |
| 文本文件读取 | 先前只有输入禁用 | 已补 Reading text file 状态与共用动效，完成或出错时撤下 |
| 点击操作到原生确认之间 | 先前主要依靠按钮禁用 | 已补 `PendingCommandStatus`，主页面和顶层 Sheet 都可见；只表示请求等待，不冒充 Actor 已开始执行 |
| 图标、折叠箭头、Markdown 阅读、主题 | 大部分为静态或即时状态切换 | 未发现被 reduced-motion 错误关闭的反馈；减少透明度是独立偏好，不混用 |
| OAuth 系统页、键盘、原生宿主 | 系统控件／原生状态投影 | 当前自有代码没有统一禁用动画；系统内部表现由系统负责，本轮没有逐一开启 OAuth 流程验证 |

直接复用：[PendingCommand.tsx](../../apps/ios/tah-ui/src/components/PendingCommand.tsx)、[useSheetDismiss.ts](../../apps/ios/tah-ui/src/useSheetDismiss.ts)、[共用样式](../../apps/ios/tah-ui/src/styles.css)。`PendingCommandContext` 只分享 UI 请求等待状态，不增加业务状态机，不改变 Framework／Adapter／Backend 边界。

新增回归覆盖：低动态关闭动画结束后才通知关闭；取消拖动只在透明时复位且保留草稿；正常模式仍位移；卸载后不执行迟到回调；忙碌 phase 缺失时仍有文字；文件读取完整生命周期；原生尚未报告 busy 的命令等待在 Sheet 内可见。131 项前端检查与构建通过。具体装机／实测范围见 [全界面动态效果检查记录](../../tools/mobile-tah/results/2026-11-02-motion-audit.json)。

本轮真机复测：Settings 短拉后保持打开并恢复原位；长拉可关闭；复位后可继续切换外观；切换记录期间能看到 Processing 文字兜底。没有为验证动效重复调用模型。动画时序与透明时复位由回归测试验证，真机检查的是实际交互结果。

最新撤回记录：[统一正常动效](../../tools/mobile-tah/results/2026-11-02-normal-motion.json)。保留前次审计的事实与已解决的等待反馈问题，但不继续推广已被用户否决的淡出／呼吸方案。


## Settings 关闭闪动与保存时机（2026-11-02）

用户指出下拉收回 Settings 后主页面闪一下。复现发现关闭回调调用 `checkpoint()`，被统一投影为全局 pending：顶部插入 Saving draft 行，改变 flex 布局，同时禁用／变淡主页面控件；保存结束又全部恢复。此前“所有请求都加 loading”的处理过于宽泛，自动保存不属于用户需要等待的前台操作。

用户进一步明确：**保存发生在设置修改时，关闭面板没有修改行为，不应触发保存。** 当前 `Settings` 的模型、reasoning、context window、Web、笔记语言修改走 `editSettings → updateDraft → checkpointDraft`，交互语言变更确认后同样 checkpoint；阅读外观和气泡样式选择时直接保存偏好。关闭按钮、下拉、遮罩和 Escape 均只关闭。

自动保存仍使用同一个串行 transport queue：先同步最新草稿，再落盘；允许用户继续编辑，随后点发送或切换等操作会排在保存后，不能丢掉点击。保存确认不采用可能含旧草稿／瞬时 refresh busy 的快照重绘页面；后续普通 snapshot 负责同步。保存错误仍显示，不能为了视觉稳定吞掉错误。普通指令输入的防抖与最终 App 生命周期恢复范围不变。

另一个亮度跳变来自遮罩只在滑动结束时清除。现在滑动关闭／回弹的同一时间内渐变遮罩背景色；抽屉本体保持原来的连续位移，不重新引入淡出／隐藏复位。恢复触发按钮焦点使用 `preventScroll`。当前设备的短时画面验证与源码／回归证据分开记录，不能仅靠测试通过断言用户视觉舒适度。

来源：[controller.ts](../../apps/ios/tah-ui/src/controller.ts)、[Settings.tsx](../../apps/ios/tah-ui/src/components/Settings.tsx)、[readingTheme.ts](../../apps/ios/tah-ui/src/readingTheme.ts)、[Sheet.tsx](../../apps/ios/tah-ui/src/components/Sheet.tsx)、[useSheetDismiss.ts](../../apps/ios/tah-ui/src/useSheetDismiss.ts)。验证记录：[Settings 保存与关闭](../../tools/mobile-tah/results/2026-11-02-settings-close.json)。


## 模型对外名称与内部标识（2026-11-02）

这是所有 provider 的通用边界，不是某个 Codex 模型的特例：**对外名称给人看，内部模型 ID 给机器用。** Adapter／原生 catalog 同时保留稳定 ID 与显示名称；模型菜单和输入区配置入口优先显示名称，不拼接 `名称 · model-id`；名称缺失或为空时直接显示模型 ID 作为兜底。option value、草稿 settings、原始历史元数据和 provider 请求继续使用原 ID，不能反过来把显示名称当 API 参数。

历史版本配置使用同一 provider 的 catalog 按 ID 查显示名称；不同 provider 之间不能仅凭相同 ID 混用名称。缺少名称时回退到原模型 ID：此时它就是能获得的唯一名称，不能为了隐藏编号而换成无意义的占位。不可用的旧选择可以在 ID 后保留 unavailable 状态提示。Reasoning 的标准等级（例如 low、xhigh）仍按此前用户要求展示，不能把这条模型命名规则误用于把推理等级替换成长描述。

本轮修改：Settings 模型选项、输入卡片旁名称、历史笔记配置展示；底层选择／保存／发送保持原模型 ID。

用户纠正：不是禁止一切模型 ID 展示，而是避免对外名称与 ID 重复显示。已有名称优先；没有名称则显示 ID。此前“不允许编号兜底”的说法已撤回。

验证记录：[模型显示名称](../../tools/mobile-tah/results/2026-11-02-model-labels.json)。


## NVIDIA 执行期间界面掉帧（2026-11-02，优化已装机并完成负载验证）

用户确认手机本屏的旋转圈、事件更新和 full Working Events 滚动都卡顿。只读诊断保留正在运行的任务，没有重启／更新 App，没有触发新的模型任务。Core Animation 显示采样为 2–7 FPS；一次进程快照中 AlmaTAHTauri CPU 约 75.5%，WebContent 约 1%。

主线程 id 8213699 的 33 条采样栈中，21 条含 `AlmaTAHJavaScriptHost.receive` 执行 JS 回调，7 条含状态投影（其中经过 `AppRaw.allows` 重建 ISO8601DateFormatter／解析日期）。原生宿主整个 JSCore 运行时标为 MainActor，750 ms 轮询及事件通知会触发较重的刷新链。App 映像 UUID 与本地安装构建匹配后解析出这些符号。**这些调用栈不是均匀 CPU 采样，不能把 21/33 当 CPU 占比。** 系统库符号不全，具体 JS 热函数未确定。

独立回归确认 spinner DOM 节点在重复快照、最新三条事件滚动更新、秒计时变化期间保持同一实例，未发现普通 React 重挂载重置动画。该检查只证明节点身份，不证明流畅帧率。据此实施下述通用优化，保持原 TAH Framework → Adapter → Backend 边界。源码／回归通过与真机流畅度验收分开记录。

完整数据与限制：[NVIDIA UI stall](../../tools/mobile-tah/results/2026-11-02-nvidia-ui-stall.json)。回归：[spinner-continuity.test.tsx](../../apps/ios/tah-ui/src/__tests__/spinner-continuity.test.tsx)。


### 本轮通用修复与复用原则

1. **UI 线程只承担必须在 UI 上完成的工作。** 可信业务 JSCore VM 改用系统 Dispatch 串行执行器上的 Swift actor；初始化、回调、定时器、JSValue 的使用和销毁均由该 actor 管理。不是把每条任务随意丢进不同线程，也不改变业务调用顺序。模型工具代码仍在其原 provider backend 内执行。
2. **跨层传不可变快照。** MainActor 一次捕获 presentation 与 draft；构建、编码 JSON 在后台完成。数据库 RPC 的编解码移入 journal actor，Sendable 响应解码、完整日志哈希与解码也离开 MainActor。异步返回后仍验证日志身份和取消状态。仅加 `async` 或 `Task {}` 不保证离开 MainActor。
3. **历史阶段：先消除重复轮询所有者。** 当时前端保留 750 ms 活跃／4 s 空闲节奏，修复命令完成与已有轮询交错时可能叠出多个循环的问题。本轮进一步移除了健康态的原生与 Web 周期查询，见下文“事件驱动更新”；原生必要补读仍合并为一个执行与最多一个后续读取。
4. **避免在高频投影中重复创建重型对象。** Raw Guardian 的过期时间在不可变响应解码时解析一次；每次判断继续与当前时间比较、检查 provider，不能缓存成永不过期的 allowed。
5. **后台化必须配套生命周期。** 调用取消释放等待容量；关闭时停止接收、取消定时器及尚未执行的平台调用、拒绝迟到回复。取消等待不等于回滚已经开始的业务操作，也不能强行抢占同步 JS。
6. **跨语言回调也要检查。** Swift → Rust 回调只拷贝生命周期有限的字节，JSON 解析放到后台任务；future 被取消／丢弃也清理等待表。不能只检查 React 或 SwiftUI。

这些原则按 Apple 的 [响应性指南](https://developer.apple.com/documentation/xcode/improving-app-responsiveness)、[JSVirtualMachine 线程模型](https://developer.apple.com/documentation/javascriptcore/jsvirtualmachine) 与 Swift 的 [自定义 actor 执行器](https://github.com/swiftlang/swift-evolution/blob/main/proposals/0392-custom-actor-executors.md) 实现，不新增第三方调度库。

关键落点：[JSCore host](../../apps/ios/Sources/AlmaTAH/Runtime/AlmaTAHJavaScriptHost.swift)、[native controller](../../apps/ios/Sources/AlmaTAH/Runtime/TAHMobileController.swift)、[snapshot bridge](../../apps/ios/Sources/AlmaTAH/Runtime/TAHWebPresentationBridge.swift)、[journal RPC](../../apps/ios/Sources/AlmaTAH/Persistence/TAHJournalRPC.swift)、[web controller](../../apps/ios/tah-ui/src/controller.ts)、[Rust callback](../../apps/ios/tah-ui/src-tauri/src/lib.rs)。

### 验证状态

最终源码通过前端 148 项、原生 controller 19 项、working log 26 项、压力调度 40 项（三种编译配置）及 JSCore worker 9 项检查；原 core 的无模型回放发布 3 轮 revision、核对 6 个产物和 3 个多块日志。Release iOS 包已原位安装并启动。安装前后原有 61 条 journal event、10 个 publication 均保留，旧行逐字段一致，SQLite 完整性检查通过。

**真机后续验证完成。** 用户把 Device Hub 拉回前台后，坐标点击恢复。新建独立 NVIDIA action，使用与原任务相同的 GPT-6-Astra／xhigh／简体中文／Web 开启；任务完整结束，界面显示 13m3s，Rule Critic 通过。两个产物共 65,012 字节，均核对字节长度及 SHA-256；完整日志保存 40 个事件。该耗时不用于声称模型加速，云端生成路径和内容不完全相同。

| 手机持续动画场景 | 样本 | FPS 范围 | 中位数 |
| --- | ---: | ---: | ---: |
| 修改前 NVIDIA 运行中 | 33 | 2–7 | 5 |
| 优化后运行初期 | 30 | 58–60 | 59 |
| 优化后运行中段 | 30 | 58–60 | 59 |
| 优化后运行后段 | 30 | 58–60 | 59 |

这是三段分别 30 秒的 Core Animation 显示采样，不是整个任务逐帧追踪或某个 spinner 的独立计数。后段单次进程快照中宿主 CPU 约 115.6%（可超过单核 100%），连续动画仍维持上述范围；这支持“重工作不再堵 UI 线程”的解释，不能把它解读为总计算量或功耗已下降。CPU／内存点值不当作峰值或全程平均。

完整 Working Events 已打开，从尾部翻到早期及中段事件，并验证内容保留。首次 20 秒滚动采样与实际手势时间错开，排除；后续同步手势窗口混有日志滚动、触顶下拉关闭及主页手势，不能把它报告成“纯日志滚动 60 FPS”。保留原始记录和限制；用户手指连续滚动的最终手感仍需实际体验。

本轮没有卸载、重置凭证或修改原 NVIDIA action。任务结束后的备份里原 61 条 event 全部逐字段一致，publication 从 10 增至 11，SQLite 完整性仍为 `ok`。测试与采样进程已退出。

证据与最终源码哈希：[UI thread optimization](../../tools/mobile-tah/results/2026-11-02-ui-thread-optimization.json)。复现：[mobile-tah README](../../tools/mobile-tah/README.md#main-thread-responsiveness-follow-up-2026-11-02)。


## Device Hub 外接键盘状态（2026-11-02）

用户在手机未插线、Device Hub 仍共享屏幕时反馈：Revision instructions 有光标、App 显示收起键盘按钮，但 iOS 软件键盘不弹出。此前日志导航曾临时启用 Capture Keyboard，随后已关闭；关闭转发按钮不应被视为已证明 iOS 外接输入设备状态断开。

已做对照：停止 Device Hub Screen Sharing，保持手机 App 不退出；用户在手机上失焦后重新点输入框，明确确认“恢复弹出了”。因此本次现象与共享期间的键盘连接状态有关，不能直接归因于 WebView 失焦或模型负载。当前不为此重装 App 或修改用户键盘设置。

App 的 `.hide-keyboard` 目前由 `.composer-card:focus-within` 显示；按钮动作是让 textarea blur。因此“显示收起按钮”只证明输入区域有焦点，不证明系统软件键盘可见。后续集成可区分输入焦点、外接键盘、软件键盘占用视口三个状态；是否展示 Hide keyboard 应与真实可见性一致。测键盘时分别覆盖：无共享、共享且 Capture Keyboard 关闭、共享且开启；测试后结束转发／共享并确认软件键盘恢复。

## 流畅度与功耗分开验收（2026-11-02）

把业务处理移出 UI 线程，可以恢复动画与滚动，但不会自动减少计算量。此次 Actor 发热追踪中，主要应用 CPU 落在可信业务 JSCore 与其垃圾回收；不能因前端恢复 59 FPS，就认定能耗已解决。测量证据与每次安装版本见 [功耗基线](../../tools/mobile-tah/results/2026-11-02-tah-power-baseline.json)、[字节层第一轮](../../tools/mobile-tah/results/2026-11-02-native-byte-optimization.json)、[展示读取第二轮](../../tools/mobile-tah/results/2026-11-02-display-read-optimization.json)。真机验收状态以对应结果文件为准。

复用原则：高频更新只重算实际变化的展示。稳定 running 阶段可复用任务列表与已加载历史，实时授权、Raw 状态、任务 snapshot 和事件继续读取。缓存不参与 Guardian、发送许可、产物验收或发布决定。存储写入开始/结束、失败 ACK、账号/权限变化、任务阶段变化、重新编辑、切换对象与用户显式刷新都使缓存失效；迟到的异步历史不能重新覆盖已失效视图。历史全量刷新要以 Core 的当前可见集合为准，不能只与旧列表求并集，否则被隐藏的 revision 会残留。

真实 Tauri 的自动轮询读取 Swift 现有 projection；Native 轮询负责业务刷新。保持这两个职责明确，不能让 Web 每次轮询都强制触发全历史重放。第二轮的 91 项 Controller 检查覆盖上述失效与交叠，但这些无模型检查不代替整包真机功耗验收。

第二轮真机结果：关闭共享、不插电、51% 亮度，完整 NVIDIA Actor 早段为 12.8%/小时、后段为 12.1%/小时，两段均 Nominal；此前 Actor 基线为 35.5%/小时、Fair。这是短窗口整机功耗，不能声称严格控制条件下的固定降幅或 App 独占耗电。任务 10m57s 完成，两份文件和完整 Working Events 哈希核对通过，安装前 85 条事件逐字段保留。更新界面仍显示完成状态与两个产物入口。上述改进没有关闭 spinner、降低事件更新频率或改变 TAH 核心边界。

## 事件驱动更新与跨端审查（2026-11-02）

用户指出：没有用户操作、后端回调或真实状态变化时，不应为了“刷新”每 750ms 唤醒 Framework。前一轮降低了每次读取成本，但仍保留主动查询；本轮修正这个机制。Mac 仓库只读审查，不修改、不运行 Mac App，也不在 Mac 仓库运行构建或测试。手机代码的无模型编译/回放在开发机执行，真机只验功能；用户明确本轮手机插线充电，**不测功耗**。上一轮 12.1–12.8%/小时不属于本轮事件版本的测量。

### 手机实际修改

| 原因 | 修复 | 保留的边界 |
| --- | --- | --- |
| 手机收到完整 `ui.actionChanged`，却只取 ID/版本再查询；另有 750ms 定时查询 | 同任务、同 execution、同阶段的事件直接更新展示；删除 native 周期 core 查询 | phase/operation/终态变化补读权威快照，progress 不推断编辑许可、发布或 Guardian 结果 |
| 较旧快照可能晚于新事件返回 | 保留最新事件水位，同阶段合入新事件，跨阶段旧响应保留一次后续查询 | 读中收到 dirty 不能在读完时被抹掉；身份、选择、写入代际继续检查 |
| 独立 Raw 检查的 finally 清空 active 后没有 UI 通知 | 在原 Raw changed 回调后补 optional observer；mobile composition 用独立 channel/revision 发 `ui.rawChanged` | 仅失效通知，UI 再读 Core；不根据 store ACK 猜测检查结束；observer 同步返回且异常隔离 |
| Raw 保存等待重试时 pendingSave 变化可能没有 action 通知 | pendingSave 真正变化时同样触发失效通知 | 不在每次成功保存的重复 null 回调时通知；不改重试、取消、发布决定 |
| 每次 full snapshot 已内含 Raw 状态，手机又单独查询 | 复用该快照中的 Raw 状态；校验 materialID | 无内嵌状态的旧契约才补查，执行许可仍由原 Core 验证 |
| begin/每个 putChunk 也触发全量展示读取 | 成功上传分块只使旧展示缓存失效，commit/cancel/deletion/不确定失败才要求重读 | 已排队的用户显式刷新在写入结束后继续执行；不跳过存储验证 |
| Web 每 750ms/4s 请求相同 projection，跨语言编码/解析/渲染 | Swift Observation → 空载荷 `tah:changed` → React 合并读取；先订阅后首读 | 无健康态周期快照查询；命令排队、草稿 rebase、旧生命周期回复拒绝保留 |
| 多个消费者同时请求同一展示快照时重复 JSON 编码 | 按不可变 presentation＋draft 值缓存并合并同 key 在途编码 | 只缓存成功展示编码；调用保留其捕获版本，迟到结果不覆盖新 key，失败不缓存 |
| 同值赋值及 log 元数据重复发观察通知 | 完整构建 next presentation 后有变化才赋值；相同 log 状态不重复通知 | 本地转圈、经过时间与正常交互动画继续工作 |
| 去掉轮询后真实到期、恢复和通知失败需要覆盖 | Raw 的真实 expiresAt 一次性定时；App 激活/系统时间变化一次补读；通知通道失败显式标记不可用 | 不自行推断 Auth TTL；不通过计时器发起模型检查；失败不能假装界面仍同步 |

Raw 观察钩子由 [runtime_notifications.mjs](../../tools/mobile-tah/runtime_notifications.mjs) 在打包时施加到已锁定的 AppActions 源码，逐一检查 source-lock 哈希和替换唯一性。原 `upstream` 文件与 `source-lock.json` 不变，manifest 记录原/新哈希与每一处替换。新增能力是展示通知；Framework → Provider Adapter → Provider backend 边界、任务顺序、提示词和校验均不变。后续若统一核心版本，应在核心提供正式观察接口，再移除这个可追踪适配。

### 交给 Mac Session 的只读发现与建议修法

下表“确认”仅表示静态调用链成立，**不表示已测得 Mac CPU 或功耗占比**。优先用真实任务的读取次数/字节数定位，再做请求内复用；不要先放开跨请求缓存。

| 项目与代码位置（相对 ALMA 根目录） | 触发与证据 | 建议修法／验收要点 |
| --- | --- | --- |
| 已有优势：`app/Sources/AlmaApp/TAH/TAHNativeActions.swift` 的 `observe` | 普通 progress 直接应用 phase/events/presentation；阶段变化补读历史、终态补读快照 | 保留这个事件驱动路径；本轮手机已借鉴，不应把旧手机轮询移回 Mac |
| 确认：`app/TAH/src/app-runtime/actions.ts` snapshot；`durable-persistence.ts` 的 acceptedPublications/latestProposal | 同一个 action snapshot 内，两者分别读同一 action journal 并 replay；conversation 可见性计算还会再读 | 提供单请求内的已验证 committed projection，同时产出 publications/proposal。保持独立于写队列状态，覆盖发布交错、pending、retry、删除及损坏记录 |
| 确认：`raw-safety.ts` status/#receipt/#key | 有效 profile 下，同一 status 两次计算包含全文、prompt、policy 的 key；手机旧刷新还重复请求 raw.status | 在单次请求传递已计算 key；完整 snapshot 的内嵌 Raw 状态可复用。不得缓存成永久 allowed，仍检查身份、策略版本和 TTL |
| 确认：`actions.ts` workingText | 每取 48KiB chunk 又校验整份日志 hash；历史路径每块还重读 operation。已有 pin 命中后仍重算 hash | 在有界 lease 中复用已验证不可变 bytes/digest，保留最终客户端整份校验与前后 operation 身份校验。测多块日志、换 execution、旧 revision、hash 错误、读取中 reedit |
| 确认：`presentation.ts` event/snapshot/workingLog；`actions.ts` #event/#push | 一些无展示变化的事件仍清日志缓存；全量序列化/hash 后才进入 latest 通知合并队列 | 先判定展示 dirty，再合并可延后的投影计算。不能漏掉阶段/终态、截断标记、Guardian/Actor 隔离、工具完成状态；用输出差分和 hash 计数验收 |
| 确认：`actions.ts` list | 每页最多 32 行，每行查询 meta/operation/publication，并重复扫 pending | 同请求读取 pending 一次并索引，结合一致性需求批量元数据查询；不能按 actionID 永久缓存 pending |
| 条件性重复：`TAHNativeActions.swift` 多窗口 progress 分发；`TAHWorkingLogReader.swift` | 主控制器和同 Action 会话窗口可能重复终态 snapshot；日志触发 key 含 phase，同 hash 也可能重读 | 对同 Action/代际合并在途读取；借鉴手机 loadedHash/attemptedHash。覆盖多窗口关闭、重开、失败重试、同 hash 换 operation |
| 并发风险待验证：`TAHNativeActions.swift` selectAction | `snapshot = loaded` 发生在 progress 水位比较之前，旧读可能覆盖已应用新 progress | 赋值前统一检查 source/revision/selection；同阶段合入更新事件，阶段冲突再补读。用可暂停 RPC 重现，不仅测最终值 |
| 确认：独立 Raw 完成通知缺口；Mac checkRawSafety 的 500ms 循环 | Raw changed 只增加 core revision；Mac 当前用限定轮询等结束，并有真实 expiresAt 定时 | 可移植本轮 Raw 状态通知思路。覆盖 allow/block/fail/cancel、最后 ACK 与 finally 先后、pendingSave、终态写失败；保留真实到期定时 |

不要删除 journal 连续版本、chunk 长度、SHA-256、receipt/replay 校验，也不要把 pending-save 写队列里的可变状态直接交给历史读。`stableSnapshot` 的重试保证、reedit 的可见 cycle 集合、取消与 commit 的胜者、旧账号结果隔离都属于验收约束。通知合并队列允许省略中间进度，消费者不能假定每个阶段必逐条送达。

### 本轮验证与交接状态

手机事件版已原位安装，映像 UUID `2DEAF6C5-535F-3574-9C4E-F8BF3AE3BF07`。Controller 110 项在三种 Swift 配置及 iOS 18 类型检查通过；500 个同阶段事件额外 Core RPC 数为 0。展示编码 45 项通过，相同内容 101 次顺序读取、32 次并发读取各只编码一次。真实 bundle 的 Raw 生命周期测试 12 场景、80 断言通过；前端 158 项、working-log 26 项，以及原 Core V0–V2 无模型回放通过。

真机使用新建的 129 字符合成转写 `EventTest`，GPT-6.1-Sol／low／英文笔记／Web 关闭。Raw 从 checking 自动变 allowed；V0 19.331s、V1 29.710s 完成，V1 包含 extra_guardian → saving_safety → actor → critic；两轮 Critic 均 PASS。没有用手动刷新推动任务。四个产物及两份完整日志字节长度、SHA-256 核对通过，Notes/ASR 独立页面和旧 V0 Working Events 可打开；后台回到前台保持同 PID 与正确 V1 阅读内容。此样本验证通知与正常工作流，不代表重新完成了长 NVIDIA 的本轮性能测试。

安装前 90 条 journal event 全部逐字段保留，publication 16→18，SQLite 完整性 `ok`。测试期间按用户要求插线，未采集功耗；不可沿用此前事件版之前的 12.1–12.8%/小时作为本版结果。键盘转发与屏幕共享已关闭，测试笔记留在手机中，无待发送的修订文字。没有 commit/push。详见 [验收与源码哈希](../../tools/mobile-tah/results/2026-11-02-event-driven-refresh.json)。

Mac Session 可直接从上面的交接表接手：先确认源码版本，针对单次请求内重复读取和 hash 加入计数与差分验证，再决定实现；手机的事件接入、Raw observer 测试和迟到响应测试可作为参考。Mac 本轮没有修复或运行验证，不能将表中的建议标记为已完成。

## 运行中 Full Working Events 短暂红字（2026-11-02）

用户随后亲测 NVIDIA V0、V1，总执行时间约 16 分钟，未充电、手机显示电量未下降，体感发热已解决。这是用户实际使用观察，电量显示有取整，不能据此推导零耗电或精确的每小时耗电率。

同时发现运行中滚动完整执行记录时有红字闪过。只读诊断在真实 Core 和真实 Swift reader 中分别复现了同一路径：`ui.actionChanged` 通知的日志 hash A 未固定；reader 的身份检查调用 `action.snapshot`，此时日志已变成 B，Core 只固定 B；reader 却继续读 A，收到 `busy` 后显示 `Could not read this working log.`，下一次 B 更新成功才消失。滚动处理本身没有发起日志读取。没有捕获到用户看到的那一帧，因此具体文字为复现所得，不能声称直接看到了手机原始红字。

修复位于 iOS 的 `TAHMobileWorkingLogReader`：

- Live 读取采用同一份、同 operation 的 `action.snapshot` 返回并固定的 hash。历史日志仍固定 position/hash。
- 成功后记录实际读取 hash；读取期间到来的相同版本通知不重复读，多个新版本请求只保留最新目标。
- 若分块来源失效，只有新的同 operation 快照确认 hash 已推进时才立即重试一次。没有周期轮询、无限重试或按报错文本猜测 `busy`。
- 读取期间保留已验证的事件；真正的源故障、SHA/长度/base64/schema 错误仍显示失败。校验错误不进入版本重试。
- 前后 operation 校验、4 MiB 总量与 48 KiB 分块上限、公开事件过滤、关闭/切换面板时的代际取消均保留。不会重新执行 Agent。

这是 iOS 展示读取适配的修正，不改变 Framework → Adapter → Backend 边界，也不修改上游锁定 Core。Mac 现有 reader 已从 snapshot 选择当前 hash，可作为这一接口使用方式的参考；本轮没有改动 Mac。

回归入口：`python3 apps/ios/Sources/AlmaTAH/Presentation/working-log-checks.py` 和 `python3 apps/ios/Sources/AlmaTAH/Presentation/working-log-version-checks.py`。专用测试记录每次可见状态，检查读取期间是否闪错以及请求次数；不能仅检查最后成功状态。验收结果及安装身份见 `tools/mobile-tah/results/2026-11-02-working-log-version-fix.json`。

验收：原有 26 项检查、专用 32 场景（219 次状态回调、96 次分块调用）、Swift 6 严格并发与模拟器类型检查通过，无诊断；真机 Release 编译通过。已原位安装并启动，映像 UUID `75315C7D-B95C-3B95-AF79-33158556FAD0`，主页面可正常显示。安装前后 112 条 journal event 全部逐字段一致，SQLite 完整性正常、pending 为 0。屏幕共享及键盘转发已关闭。本轮没有再调用模型或运行长 NVIDIA 任务，运行中版本竞争由确定性回归覆盖，尚未做新版本的真机运行中滚动复测；未测功耗。

## Working Events 内存增量与 Tauri Channel（2026-11-02）

用户提出：慢读者不能反复追赶持续更新的整份日志；实时展示应使用内存，新事件与历史加载要无缝衔接。查阅成熟实现后，采用初始状态＋增量、消费确认与有界缓冲，并使用 Tauri 官方 Channel。研究依据：[Kubernetes List/Watch](https://kubernetes.io/docs/reference/using-api/api-concepts/#efficient-detection-of-changes)、[xterm.js 流量控制](https://xtermjs.org/docs/guides/flowcontrol/)、[Tauri Channel](https://v2.tauri.app/develop/calling-frontend/#channels)。历史分页与虚拟列表是独立后续项：[Grafana 历史与 tail](https://grafana.com/docs/loki/latest/reference/loki-http-api/#stream-logs)、[TanStack Virtual](https://tanstack.com/virtual/latest/docs/chat)。

当前实现分层：

1. Core 的原有 `AppPresentationTracker` 仍拥有公开事件状态。可追踪、hash-checked 的构建适配增加同步 `workingView`，证明 action/operation/tracker 所有权后复制受限内存视图；不通过日志文件、journal 回放或重新执行 Agent 取得事件。持久化、授权和发布规则不变。
2. `WorkingStream` 提供 `action.workingOpen`／`action.workingNext`／`action.workingClose`。首次 reset，后续按事件 ID 返回 upsert、remove、order 和元数据；序号检查当前基线。一个 runtime 只有一个读会话，内存只保留一份已交付基线。开始下一 execution、删除、身份失效和关闭使旧 scope 不可读；完成后的同一份内存可以完成最后交付。
3. Swift 内存 reader 只在新事件或显式重试时请求，消费者不就绪时只标记 dirty。取得一批后等待 Web 消费；10000 次生产端更新不等于 10000 次读取。已完成/历史记录继续使用原有位置、SHA 和分块校验路径。
4. Swift `TAHWorkingLogChannel` 只保留一批未确认 frame 和最新展示状态，差分/编码离开 MainActor。通过 C callback 把临时借用字节复制到 Rust 的容量 1 队列；后台 worker 解析并调用官方 `Channel::send`。Web 应用增量并获得一次渲染机会后，才 ACK 对应 subscription/sequence，进而放行下一次内存读取。
5. 普通界面快照在 Channel 启用时不包含完整 Working Events 正文，仍保留打开面板所需身份和元数据。旧订阅、旧面板和错误 base sequence 不能覆盖当前面板。关闭/重订阅释放旧流，不恢复定时轮询。

两套序号分别服务于 Core 内存读取和 Web 传输，不承担业务 revision 决策。Channel 是传输工具，不提供应用级持久化或自动补读；重订阅从当前受限内存状态 reset。限流只作用于展示消费，不能因 WebView 慢而停止 provider 事件接收。任务完成依旧以原 Core 的提交结果为准。

保留现有 512 个事件、2 MiB 文本、4 MiB 序列化日志限制以及截断提示；传输 envelope 上限 8 MiB。这里没有承诺无限完整历史，也没有把已丢弃记录伪装成分页可恢复。真正历史分页需要另立事件留存方案。

回归入口：`tools/mobile-tah/working_stream_checks.py`、`Presentation/working-channel-checks.py`、原 working-log/bridge/controller 检查和前端 stream 测试。验收需检查中间状态与调用次数，涵盖暂停 ACK、突发更新、重新消费、同 ID 状态修改、删除、终态、关闭重开、错误序号和旧 revision；不能仅检查最终文字。此次改造尚需以最终真机安装记录确认交付，不沿用上一版安装 UUID。

已通过：后台 10 组隔离测试、22 项真实 Core 检查和 80 个 Raw 断言；Swift 通道 40 场景；原日志 26 项；Controller 110 项 × 3 配置；展示编码 45 项 × 4 配置；前端 186 项。真实 Core V0–V2 无模型回放验证 3 次发布、6 个产物、3 份分块日志。Swift 类型检查和 Release 真机链接成功。一次压力测试暂停消费时累计 10000 次更新，验证只保留最新状态，内存读取的 journal 调用为 0。

最终原位安装映像 UUID `16066F36-30FB-3BB7-B364-8F46D4838C42`。用户将 Device Hub 置前后恢复控制。真机发现并修复一处独立集成遗漏：新命令虽已实现/注册，但 `build.rs` 的 AppManifest 和主窗口 capability 没加入三个 Channel 命令，导致真实 IPC 被拒绝，而 mockIPC 测试仍通过。已补上窄范围声明及跨配置回归检查；新增 Tauri command 必须同时核对实现、invoke handler、AppManifest、capability，不能仅测前端调用桩。

真机验证通过：EventTest 旧 V0 全量日志经 Channel 显示；新建三次 EventTest V0，GPT-6.1-Sol/low，均正常发布并通过 Critic。前两次在自动化进入动态入口前已完成，第三次立即打开完整日志，从初始 Progressing 观察到工具事件增量抵达，再自动进入 Critic Passed，无手动刷新或红字。第三次任务耗时 42.802s，仅作功能验证。随后切换到 NVIDIA 最近保存任务，打开 V0 完整记录、向前滚动及返回最新记录正常；没有再运行长 NVIDIA 推理。

六个新产物及三份新日志 SHA/长度校验通过。原有 112 条 journal event 逐字段保留，总数变成 127；SQLite 完整性正常、pending=0。屏幕共享及键盘转发已关闭，App 留在已完成的 NVIDIA 任务，无新草稿。本轮未测功耗/FPS，不将无模型压力测试或短任务耗时当作真机吞吐提升。详细状态见 [Channel 验证记录](../../tools/mobile-tah/results/2026-11-02-working-channel.json)。

## 草稿静默保存（2026-11-02）

用户要求输入时不显示 `Saving draft…`，避免提示反复出现、挤占对话框空间和改变布局。已删除 composer 的 dirty 状态提示及专用 CSS；后台自动保存、设置即时保存、切换/提交前 flush 和现有失败处理继续沿用。集成手机版复用时，正常草稿保存不占布局、不显示加载提示；不要因为移除提示而移除 dirty 跟踪或保存流程。

前端 186 项既有测试及生产构建通过，已原位更新并启动手机 App。127 条 journal event 与保存的草稿/设置全部保留；未运行模型或开启投屏。
