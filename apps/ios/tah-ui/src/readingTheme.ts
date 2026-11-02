export type ReadingTheme = 'ink' | 'paper';
export const readingThemeKey = 'alma.tah.reading-theme.v1';
export function loadReadingTheme(): ReadingTheme {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(readingThemeKey) ?? 'null');
    if (saved && typeof saved === 'object' && 'version' in saved && saved.version === 1 &&
      'theme' in saved && (saved.theme === 'ink' || saved.theme === 'paper')) return saved.theme;
  } catch { /* An unavailable store must not prevent opening the app. */ }
  return 'ink';
}
export function saveReadingTheme(theme: ReadingTheme): void {
  try { window.localStorage.setItem(readingThemeKey, JSON.stringify({ version: 1, theme })); }
  catch { /* The current in-memory choice still applies. */ }
}
