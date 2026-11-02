export default {
  root: new URL('.', import.meta.url).pathname,
  cacheDir: new URL('.cache/vitest/', import.meta.url).pathname,
  test: { include: ['generate.test.ts'], fileParallelism: false, maxWorkers: 1,
    testTimeout: 15000, watch: false },
};
