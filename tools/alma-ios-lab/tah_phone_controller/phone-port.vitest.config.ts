export default { root: new URL(".", import.meta.url).pathname,
  cacheDir: new URL(".phone-test-cache/", import.meta.url).pathname,
  test: { include: ["phone-port.test.ts"], fileParallelism: false, maxWorkers: 1, testTimeout: 10000 } };
