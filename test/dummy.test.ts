/**
 * Dummy unit test file used by CI/CD pipeline to verify the test runner works.
 * This file is intentionally simple — it exists to validate that the GitHub Actions
 * workflow can install dependencies and execute tests successfully.
 */
import { describe, it, expect } from "vitest";

describe("Dummy Test Suite", () => {
  it("should pass a basic assertion", () => {
    expect(1 + 1).toBe(2);
  });

  it("should verify truthy values", () => {
    expect(true).toBeTruthy();
    expect("hello").toBeTruthy();
    expect(42).toBeTruthy();
  });

  it("should verify string operations", () => {
    const greeting = "Hello, CI/CD!";
    expect(greeting).toContain("CI/CD");
    expect(greeting).toHaveLength(13);
  });
});
