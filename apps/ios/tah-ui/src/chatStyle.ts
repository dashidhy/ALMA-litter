export type ChatStyle = 'bubbles' | 'light';
export const chatStyleKey = 'alma.tah.chat-style.v1';

export function loadChatStyle(): ChatStyle {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(chatStyleKey) ?? 'null');
    if (saved && typeof saved === 'object' && 'version' in saved && saved.version === 1 &&
      'style' in saved && (saved.style === 'bubbles' || saved.style === 'light')) return saved.style;
  } catch { /* Storage may be unavailable in a restricted webview. */ }
  return 'bubbles';
}
export function saveChatStyle(style: ChatStyle): void {
  try { window.localStorage.setItem(chatStyleKey, JSON.stringify({ version: 1, style })); } catch { /* In-memory choice still applies. */ }
}
