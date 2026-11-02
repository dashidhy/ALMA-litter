export default {
  root: new URL(".", import.meta.url).pathname,
  cacheDir: new URL(".test-cache/", import.meta.url).pathname,
  test: { include: ["controller.test.ts", "file-journal.test.ts"], fileParallelism: false, maxWorkers: 1,
    testTimeout: 10000, watch: false },
};
