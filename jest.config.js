const nextJest = require("next/jest");

const createJestConfig = nextJest({ dir: "./" });

/** @type {import('jest').Config} */
const config = {
  projects: [
    // Node environment for lib and API tests (filesystem, SQLite, etc.)
    {
      displayName: "server",
      testEnvironment: "node",
      testMatch: [
        "<rootDir>/__tests__/lib/**/*.test.ts",
        "<rootDir>/__tests__/api/**/*.test.ts",
        "<rootDir>/__tests__/components/**/*.test.ts",
        "<rootDir>/__tests__/integration/**/*.test.ts",
      ],
      transform: {
        "^.+\\.tsx?$": "ts-jest",
      },
      moduleNameMapper: {
        "^@/(.*)$": "<rootDir>/src/$1",
      },
      testPathIgnorePatterns: ["/node_modules/", "/.next/"],
    },
    // jsdom environment for component/UI tests
    {
      displayName: "client",
      testEnvironment: "jsdom",
      setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
      testMatch: ["<rootDir>/__tests__/components/**/*.test.tsx"],
      transform: {
        "^.+\\.(js|jsx|ts|tsx|mjs)$": [
          "next/dist/build/swc/jest-transformer.js",
          { nextConfigPath: "<rootDir>/next.config.mjs" },
        ],
      },
      moduleNameMapper: {
        "^@/(.*)$": "<rootDir>/src/$1",
      },
      testPathIgnorePatterns: ["/node_modules/", "/.next/"],
    },
  ],
};

module.exports = createJestConfig(config);
