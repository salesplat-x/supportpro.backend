/** @type {import('jest').Config} */
module.exports = {
  preset: "ts-jest",
  testEnvironment: "node",
  roots: ["<rootDir>/tests"],
  testMatch: ["**/*.test.ts"],
  setupFiles: ["<rootDir>/tests/setup.ts"],
  testTimeout: 120000,
  // Every suite leaves its module registry pinned in the process (the testcontainers reaper
  // socket and express-rate-limit's store timers outlive it), so one long-lived process
  // runs out of heap partway through the suite. Recycle the worker before that happens.
  workerIdleMemoryLimit: "1GB",
  transform: {
    "^.+\\.tsx?$": ["ts-jest", { tsconfig: "tsconfig.jest.json" }],
  },
  workerThreads: false,
  extensionsToTreatAsEsm: [],
  // Map .js imports to .ts sources — required for NodeNext module resolution
  moduleNameMapper: {
    "^(\\.{1,2}/.*)\\.js$": "$1",
  },
};
