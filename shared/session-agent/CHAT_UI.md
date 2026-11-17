# Session Agent 聊天界面

2026-11-17：用户要求沿用旧 TAH 的气泡和输入习惯，并准备只有 transcript 的全新 workspace 亲自体验。

- 直接复用旧 TAH 的 `.chat-message` 双侧气泡、Alma 头像、阅读主题与对话样式偏好。
- 输入区使用原来的悬浮 `.composer-card`、两行输入、模型/推理设置入口、收起键盘按钮及上箭头发送按钮。
- 同样使用 `useComposerInset` 和 VisualViewport 几何处理，给最后一条消息保留卡片空间。
- 原型独有的 Skill 选择放在加号按钮中；保留 `/asr-review`、`/structured-notes` 补全和已选 Skill 提示。
- Skill 点击保持编辑焦点，避免 WebKit 中 blur 隐藏键盘按钮后导致按钮换位、点击失效。
- 发送确认前防止重复提交；新写的草稿不被上一条提交回执清空。切换 session 时草稿按 session 恢复。
- 不改变原生会话、角色、Skill 文案、模型或授权的实现；不重新引入旧 TAH 的 guardian/revision 流程。

检查记录：`tools/mobile-tah/results/2026-11-17-session-agent-ui/acceptance.json`。
WebKit 截图使用浏览器模拟资料与输出版式，不是手机模型生成结果。真机交付的 workspace 不填入这些测试消息。

0.5.0 (22) 已安装；新 workspace 在冷启动后仍保持同一空 thread，业务文件只有完整 `transcript.md`，assets 和聊天均为空。真机首屏已检查，未发送任何模型请求。手机留在输入页面供用户体验。
