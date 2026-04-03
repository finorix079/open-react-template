# CI/CD Pipeline Documentation

## Overview

This project uses **GitHub Actions** to run a continuous integration (CI) pipeline that executes unit tests automatically. The pipeline ensures code quality by gating merges on passing tests.

## Workflow File

The workflow is defined in `.github/workflows/ci.yml`.

## Triggers

The CI pipeline runs on two events:

| Event | Condition | Purpose |
|-------|-----------|---------|
| `push` | To the `master` branch | Validates that merged code passes all tests |
| `pull_request` | Targeting the `master` branch | Validates proposed changes before merge |

## Pipeline Steps

The `test` job runs on `ubuntu-latest` and performs the following steps:

### 1. Checkout Repository
Uses `actions/checkout@v4` to clone the repository into the runner.

### 2. Install pnpm
Uses `pnpm/action-setup@v4` which automatically reads the `packageManager` field in `package.json` to install the correct pnpm version.

### 3. Setup Node.js
Uses `actions/setup-node@v4` with Node.js 20 and enables pnpm caching for faster subsequent runs.

### 4. Install Dependencies
Runs `pnpm install --no-frozen-lockfile` to install project dependencies. The `--no-frozen-lockfile` flag is used because the `elasticdash-test` dependency references a local file path (`file:../elasticdash-test-js`) that does not exist in the CI environment.

### 5. Run Unit Tests
Runs `pnpm test` which executes `vitest run` — running all `*.test.ts` files in the project.

## Test Framework

- **Runner:** [Vitest](https://vitest.dev/) (configured via the `test` script in `package.json`)
- **Test location:** `test/` directory
- **Test pattern:** `*.test.ts`

## How to Run Tests Locally

```bash
# Run all tests once
pnpm test

# Run tests in watch mode
pnpm vitest
```

## Adding New Tests

1. Create a new file matching the pattern `*.test.ts` (e.g., `test/myFeature.test.ts`)
2. Import from `vitest`:
   ```ts
   import { describe, it, expect } from "vitest";
   ```
3. Write your test cases
4. Run `pnpm test` locally to verify
5. Push or open a PR — the CI pipeline will run your tests automatically

## Branch Protection (Recommended)

To enforce that tests must pass before merging, configure branch protection rules on `master`:

1. Go to **Settings → Branches → Branch protection rules**
2. Add a rule for `master`
3. Enable **Require status checks to pass before merging**
4. Select the **Unit Tests** check
5. Optionally enable **Require branches to be up to date before merging**

## Troubleshooting

| Issue | Solution |
|-------|---------|
| `pnpm install` fails | The `elasticdash-test` local dependency is expected to be missing in CI. The `--no-frozen-lockfile` flag handles this. If other dependencies fail, check the `pnpm-lock.yaml` is committed. |
| Tests pass locally but fail in CI | Check for environment-specific code (file paths, env vars). CI runs on `ubuntu-latest` with Node.js 20. |
| Workflow not triggering | Verify the branch name is `master` (not `main`). Check the workflow file is on the target branch. |
