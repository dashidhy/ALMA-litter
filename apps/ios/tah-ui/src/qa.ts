// A separate, explicitly opened development entry. Not imported by main.tsx.
if (import.meta.env.DEV) {
  const { installFixture } = await import('./devFixture');
  installFixture();
  await import('./main');
} else {
  document.getElementById('root')!.textContent = 'Preview data is available only on the local development server.';
}
export {};
