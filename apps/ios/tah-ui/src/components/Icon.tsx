export type IconName = 'library' | 'settings' | 'back' | 'close' | 'plus' | 'send' | 'chevron' | 'refresh' | 'document' | 'check' | 'hideKeyboard';
const paths: Record<IconName, string> = {
  library: 'M4 4v16M9 4v16M14 4l5 16M3 4h2M8 4h2',
  settings: 'M4 7h16M4 17h16M9 4v6M15 14v6',
  back: 'M19 12H5m7-7-7 7 7 7', close: 'm6 6 12 12M6 18 18 6',
  plus: 'M12 5v14M5 12h14', send: 'M12 19V5m-6 6 6-6 6 6',
  chevron: 'm9 5 7 7-7 7', refresh: 'M20 7v5h-5M4 17v-5h5M6 6a8 8 0 0 1 13 2M18 18A8 8 0 0 1 5 16',
  document: 'M14 3H5v18h14V8l-5-5Zm0 0v5h5M8 12h8M8 16h6',
  check: 'm5 12 4 4L19 6',
  hideKeyboard: 'M3 4h18v11H3V4Zm4 4h.01M11 8h.01M15 8h.01M18 8h.01M7 12h10m-9 7 4 3 4-3',
};
export function Icon({ name }: { name: IconName }) {
  return <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name]} /></svg>;
}
