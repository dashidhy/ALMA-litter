// Explicit visual QA only. This module is never imported by the application entry.
import type { Commands, Method, Snapshot, WorkingSummary } from './contract';
import type { Transport } from './bridge';

export const notes = `# 让重要的信息更容易被找到

## 讨论重点

团队决定让第一版专注于 **清晰的笔记** 与可靠的手机阅读体验。保留完整上下文，也让读者快速找到决定、依据与后续行动。

- 保留原始转录，不静默替换说话人的用词。
- 把已经做出的决定与仍待确认的问题分开。
  - 记录不确定性，不把推测写成事实。
  - 需要时提供参考链接，点击后才打开。

### 决定与下一步

| 决定 | 负责人 | 下一步 | 时间 |
| --- | --- | --- | --- |
| 简化手机阅读流程 | 设计团队 | 检查小屏幕中的标题层次、长表格与横向滚动 | 周五 |
| 保留原始表达 | 工程团队 | 对照完整转录核对笔记，避免遗漏边界条件 | 下次评审 |

> “让有用的部分容易找到，也让不确定的部分保持可见。”

1. 阅读结构化笔记，检查决定与行动项。
2. 切换到 ASR terms，单独核对疑似转录问题。
3. 需要调整时，回到对话并提交修订说明。

### 技术细节与长代码

~~~typescript
const result = await native.readMaterial({ actionID: "sam-workspace-review", revisionIndex: 0, file: "structured-notes.md" });
~~~

需要时打开 [项目参考资料](https://example.com/notes)。预览模式只记录点击，不打开远程网站。

### 核对清单

- [x] 保留完整转录
- [ ] 核对术语与说话人

图片保持为文字占位，不自动联网：![白板草图](https://example.com/no-auto-fetch.png)
`;
export const terms = `# 疑似 ASR 术语

下面的条目是需要人工核对的疑似转录问题，与结构化笔记分开保存。横向滑动表格可以查看完整证据和后续处理建议。

| 原始转录片段 | 可能的术语 | 上下文与判断依据 | 置信度 | 后续处理 |
| --- | --- | --- | --- | --- |
| SAM workspace | SAM 工作区 | 在讨论中多次出现，保留英文缩写与原有大小写，避免误认成其他产品名 | 高 | 暂不替换 |
| context wind oh | context window（上下文窗口） | 说话人正在讨论模型设置中的 token 数量限制；需要对照完整录音确认 | 中 | 对照来源核验 |
| ship the reed view | ship the read view | 当时正在评审手机阅读页面，可能指交付阅读视图，而不是另一项功能 | 中 | 询问说话人 |
| speech_recognition_material_revision_reference | 语音转录材料修订引用 | 这个很长的标识符用于检查表格横向溢出是否安全，不应撑宽整个页面 | 待确认 | 保留原文 |

## 保留不确定性

这些建议仅供核对。不要静默修改原始转录，也不要把疑似词项混进已确认的结论。
`;

export function makeFixture() {
  let materialSequence = 0;
  let logSequence = 0;
  let snapshot: Snapshot = {
    presentation: {
      transcripts: [{ id: 'qa-transcript', title: 'SAM · Workspace review', enabled: true }, { id: 'qa-other', title: 'Product notes · October', enabled: true }],
      transcriptID: 'qa-transcript', actions: [{ id: 'qa-action', title: 'Structured Notes · SAM', enabled: true }],
      editor: { actionID: 'qa-action', editorToken: 'qa-editor-1' },
      models: [{ id: 'gpt-6-astra', title: 'GPT-6 Astra', enabled: true }],
      efforts: [{ id: 'xhigh', title: 'Very high reasoning description must not be used as an ID', enabled: true }],
      contextWindows: [{ id: 272000, title: '272,000 tokens', enabled: true }],
      interactionLanguage: 'en', initialSettingsFrozen: true, canOmitInstructions: false, consentGranted: true,
      rawStatus: 'Transcript safety: allowed', rawExplanation: 'The transcript is ready to use with the selected provider.', rawValidityLabel: null,
      status: 'editing', disabledReason: null, error: null, isBusy: false,
      timeline: [
        { id: 'qa-user', title: 'You · v0', role: 'user', revisionIndex: 0, phase: 'completed', text: 'Focus on decisions and next steps. Keep #raw_text and <speaker> exactly as written.', markdown: false, detail: null, canExpand: false },
        { id: 'qa-answer', title: 'TAH · v0', role: 'assistant', revisionIndex: 0, phase: 'published', working: fixtureWorking(0), text: 'The notes are ready.\n\n- **Decisions** are grouped together.\n- Follow-ups include owners where stated.\n- Possible transcription issues are in the ASR terms file.', markdown: true, detail: 'gpt-6-astra · xhigh', canExpand: false },
        { id: 'qa-user-1', title: 'You · v1', role: 'user', revisionIndex: 1, phase: 'completed', text: 'ASR-01 就是 align（对齐）。请更新正文，并移除这个疑点。', markdown: false, detail: null, canExpand: false },
        { id: 'qa-answer-1', title: 'TAH · v1', role: 'assistant', revisionIndex: 1, phase: 'published', working: fixtureWorking(1), text: '已将 ASR-01 修正为 **align（对齐）**。正文和疑点索引已同步更新，目前没有待复核项。', markdown: true, detail: null, canExpand: false },
      ],
      revisions: [{ id: 'publication/qa-v0', revisionIndex: 0, configurationLabel: 'ChatGPT · gpt-6-astra · xhigh · 272000' },
        { id: 'publication/qa-v1', revisionIndex: 1, configurationLabel: 'ChatGPT · gpt-6-astra · xhigh · 272000' }],
      hasMoreHistory: false, material: null, currentActivity: null, workingLog: null,
      permissions: { selectTranscript: true, importTranscript: true, selectAction: true, checkRaw: false, createAction: true,
        edit: true, editConsent: true, editInteractionLanguage: true, send: false, readMaterial: true, loadHistory: true },
    },
    draft: { outputLanguage: 'en', settings: { providerID: 'chatgpt', modelID: 'gpt-6-astra', reasoningEffortID: 'xhigh', contextWindowTokens: 272000, webEnabled: false }, instructions: '', consent: false },
  };
  const calls: { method: Method; value: Commands[Method] }[] = [];
  const listeners = new Set<() => void>();
  const changed = () => listeners.forEach(listener => listener());
  const transport: Transport = { subscribeChanges: async listener => { listeners.add(listener); return () => { listeners.delete(listener); }; }, async call(method, value) {
    calls.push({ method, value: structuredClone(value) });
    const p = snapshot.presentation;
    switch (method) {
      case 'updateDraft': {
        const input = value as Commands['updateDraft'];
        if (JSON.stringify(input.context) === JSON.stringify(p.editor)) snapshot.draft = structuredClone(input.draft);
        p.permissions.send = p.permissions.edit && (p.canOmitInstructions || Boolean(snapshot.draft.instructions.trim()));
        p.permissions.checkRaw = !p.consentGranted && snapshot.draft.consent;
        break;
      }
      case 'selectInteractionLanguage': p.interactionLanguage = (value as Commands['selectInteractionLanguage']).language; break;
      case 'checkRawSafety': p.consentGranted = true; p.rawStatus = 'Transcript safety: allowed'; p.permissions.checkRaw = false; break;
      case 'selectTranscript': p.transcriptID = (value as Commands['selectTranscript']).id; p.editor = null; p.actions = []; p.timeline = []; p.revisions = []; p.material = null; p.currentActivity = null; p.workingLog = null; break;
      case 'importTranscript': {
        const input = value as Commands['importTranscript'];
        p.transcripts.push({ id: `qa-import-${p.transcripts.length}`, title: input.title || 'Transcript', enabled: true });
        p.transcriptID = p.transcripts.at(-1)!.id; p.editor = null; p.actions = []; p.timeline = []; p.revisions = []; break;
      }
      case 'createStructuredNotesAction':
        p.editor = { actionID: 'qa-new-action', editorToken: 'qa-new-editor' };
        p.actions.push({ id: 'qa-new-action', title: 'Structured Notes · New', enabled: true });
        p.initialSettingsFrozen = false; p.canOmitInstructions = true; p.permissions.send = true;
        p.timeline = []; p.revisions = []; p.currentActivity = null; p.workingLog = null; p.status = 'draft'; snapshot.draft.instructions = ''; break;
      case 'sendAction':
        // Admission only: never manufacture progress or a completed result.
        p.isBusy = true; p.status = 'preparing'; p.permissions.edit = false; p.permissions.send = false;
        p.initialSettingsFrozen = true; break;
      case 'readMaterial': {
        const input = value as Commands['readMaterial'];
        p.material = { id: `${input.actionID}/${input.kind}/${input.revisionIndex}/${input.file}/${++materialSequence}`,
          title: input.kind === 'rawTranscript' ? 'Raw transcript' : `v${input.revisionIndex} · ${input.file === 'structured-notes.md' ? 'Notes' : 'ASR terms'}`,
          text: input.kind === 'rawTranscript' ? '# This is literal transcript text\n\nAlex: Keep <speaker> labels and *uncertain words* unchanged.\n\nSam: Let’s review the notes on a phone.' : input.file === 'structured-notes.md' ? notes : terms,
          markdown: input.kind !== 'rawTranscript', isLoading: false, error: null }; break;
      }
      case 'dismissMaterial': p.material = null; break;
      case 'openWorkingLog': {
        const input = value as Commands['openWorkingLog'];
        const working = input.position === null ? p.currentActivity : p.timeline.find(item => item.working?.position === input.position)?.working;
        if (working?.canOpen && input.actionID === p.editor?.actionID) p.workingLog = {
          id: `qa-log-${++logSequence}`, actionID: input.actionID, position: input.position, revisionIndex: working.revisionIndex,
          startedAt: working.startedAt, endedAt: working.endedAt, events: structuredClone(working.events), criticPassed: working.criticPassed,
          loading: false, failed: false, limited: false, superseded: false, progressing: working.progressing, error: null,
        };
        break;
      }
      case 'closeWorkingLog': if (p.workingLog?.id === (value as Commands['closeWorkingLog']).id) p.workingLog = null; break;
      case 'signIn': delete snapshot.ready; snapshot.error = null; break;
    }
    if (method !== 'snapshot' && method !== 'checkpointDraft') changed();
    return structuredClone(snapshot);
  } };
  return { transport, calls, changed, get snapshot() { return snapshot; }, setSnapshot(value: Snapshot) { snapshot = structuredClone(value); changed(); } };
}
export function fixtureWorking(revisionIndex: number, live = false): WorkingSummary {
  return {
    id: `qa-working-${revisionIndex}`, position: live ? null : revisionIndex + 1, revisionIndex,
    phase: live ? 'actor' : 'published', startedAt: '2026-11-01T10:00:00Z', endedAt: live ? null : '2026-11-01T10:00:38Z',
    canOpen: true, live, progressing: live, criticPassed: !live,
    events: ['读取原始转写', '定位需要修正的术语', '更新结构化笔记', '更新 ASR 疑点索引'].map((title, index) => ({
      id: `qa-event-${revisionIndex}-${index}`, title, detail: index === 2 ? 'structured-notes.md\n保留原有上下文。' : '公开执行事件 · 预览数据',
      role: 'actor', kind: 'tool', titleCode: null, status: 'completed', detailTruncated: false, round: null,
    })),
  };
}
export function installFixture() {
  if (!import.meta.env.DEV) throw new Error('Fixtures are available only in development.');
  const fixture = makeFixture();
  window.__TAH_UI_FIXTURE__ = fixture.transport;
  return fixture;
}
