/**
 * Vitest configuration for unit tests.
 * Excludes *.ai.test.ts and legacy aiHandler test files which are designed
 * for the elasticdash test runner and have unresolvable imports in vitest.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    exclude: [
      "**/node_modules/**",
      "**/dist/**",
      "**/*.ai.test.ts",
      "**/test/aiHandler.*.test.ts",
    ],
  },
});
