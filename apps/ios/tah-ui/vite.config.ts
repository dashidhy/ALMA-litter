import { defineConfig } from 'vitest/config';

export default defineConfig({
  base: './',
  clearScreen: false,
  server: { host: '127.0.0.1', port: 1437, strictPort: true },
  build: { target: 'safari17', sourcemap: false },
  test: { environment: 'jsdom', include: ['src/**/*.test.{ts,tsx}'], restoreMocks: true },
});
