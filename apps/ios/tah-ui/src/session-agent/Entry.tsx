import { useEffect, useState } from 'react';
import { isTauri } from '@tauri-apps/api/core';
import LegacyApp from '../App';
import SessionAgent, { nativeAgentCall } from './SessionAgent';
import { loadReadingTheme } from '../readingTheme';
import './styles.css';

type Page = 'home' | 'agent' | 'legacy';
export default function Entry() {
  const [page, setPage] = useState<Page>(() => { try { return localStorage.getItem('alma-session-agent-entry-v1') === 'agent' ? 'agent' : 'home'; } catch { return 'home'; } });
  function show(next: Page) { try { localStorage.setItem('alma-session-agent-entry-v1', next); } catch { /* Navigation still works without storage. */ } setPage(next); }
  useEffect(() => {
    document.documentElement.dataset.theme = loadReadingTheme();
    let active = true;
    if (isTauri()) void nativeAgentCall<{ openAgent: boolean }>('agent.launchInfo').then(value => { if (active && value.openAgent) show('agent'); }).catch(() => {});
    return () => { active = false; };
  }, []);
  if (page === 'agent') return <SessionAgent onBack={() => show('home')} />;
  if (page === 'legacy') return <LegacyApp onExit={() => show('home')} />;
  return <main className="agent-home"><span className="header-mark">alma</span><h1>从一份转写开始</h1><p>在同一个对话里提问、审查转写、生成和修改成果。</p>
    <button className="primary" onClick={() => show('agent')}>打开 Session Agent</button>
    <button className="secondary" onClick={() => show('legacy')}>打开旧版 Structured Notes</button>
    <small>当前原型：Codex · 共享 Skill · 持久对话</small>
  </main>;
}
