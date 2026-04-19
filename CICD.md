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

The pipeline has two jobs: **Unit Tests** and **ElasticDash AI Tests**. The AI tests job depends on unit tests passing first.

### Job 1: Unit Tests (`test`)

Runs on `ubuntu-latest`:

#### 1. Checkout Repository

Uses `actions/checkout@v4` to clone the repository into the runner.

#### 2. Install pnpm

Uses `pnpm/action-setup@v4` which automatically reads the `packageManager` field in `package.json` to install the correct pnpm version.

#### 3. Setup Node.js

Uses `actions/setup-node@v4` with Node.js 20 and enables pnpm caching for faster subsequent runs.

#### 4. Install Dependencies

Runs `pnpm install --no-frozen-lockfile` to install project dependencies. The `--no-frozen-lockfile` flag is used because the `elasticdash-test` dependency references a local file path (`file:../elasticdash-test-js`) that does not exist in the CI environment.

#### 5. Run Unit Tests

Runs `pnpm test` which executes `vitest run` — running all `*.test.ts` files in the project.

### Job 2: ElasticDash AI Tests (`elasticdash-ci`)

Runs on `ubuntu-latest` **after unit tests pass** (`needs: test`):

#### 1. Checkout Repository

Uses `actions/checkout@v4` to clone the repository (needed for `ed_tools.ts` and `ed_workflows.ts`).

#### 2. Setup Node.js

Uses `actions/setup-node@v4` with Node.js 20.

#### 3. Install elasticdash-test

Installs the `elasticdash-test` CLI globally from npm.

#### 4. Run ElasticDash CI Tests

Runs `elasticdash ci` which:

1. Fetches all active test groups from the ElasticDash backend using the project API key
2. Executes each test locally (single-step or full-flow)
3. Evaluates expectations (token budget, latency, output checks, LLM judge, etc.)
4. Submits results back to the backend
5. Creates a batch grouping all runs
6. **Exits with code 1 if any test fails** — blocking the pipeline

Git branch, commit SHA, PR number, and PR URL are auto-detected from GitHub Actions environment variables.

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

## Required GitHub Secrets

The ElasticDash AI Tests job requires the following secrets configured in **Settings → Secrets and variables → Actions → Secrets → Repository secrets** (click "New repository secret"):

| Secret | Required | Description |
|--------|----------|-------------|
| `ELASTICDASH_API_URL` | Yes | ElasticDash backend API URL (e.g., `https://server.elasticdash.com`) |
| `ELASTICDASH_API_KEY` | Yes | Project API key (starts with `ed_`). Create one in the ElasticDash dashboard under Settings → API Keys. |
| `OPENAI_API_KEY` | If tests use OpenAI | Required if any test or `llm-judge` expectation calls OpenAI models (gpt-4, etc.) |
| `ANTHROPIC_API_KEY` | If tests use Anthropic | Required if any test or `llm-judge` expectation calls Claude models |
| `GEMINI_API_KEY` | If tests use Gemini | Required if any test or `llm-judge` expectation calls Gemini models |
| `GROK_API_KEY` | If tests use Grok | Required if any test or `llm-judge` expectation calls Grok/xAI models |
| `KIMI_API_KEY` | If tests use Kimi | Required if any test or `llm-judge` expectation calls Kimi/Moonshot models |

You only need to add secrets for providers your tests actually use. Unused secrets can be left unconfigured — GitHub Actions passes empty strings for missing secrets, and the SDK only fails if a test actually tries to call that provider.

## Branch Protection (Recommended)

To enforce that both unit tests and AI tests must pass before merging, configure branch protection rules on `master`:

1. Go to **Settings → Branches → Branch protection rules**
2. Add a rule for `master`
3. Enable **Require status checks to pass before merging**
4. Select both the **Unit Tests** and **ElasticDash AI Tests** checks
5. Optionally enable **Require branches to be up to date before merging**

## Troubleshooting

| Issue | Solution |
|-------|---------|
| `pnpm install` fails | The `elasticdash-test` local dependency (`file:../elasticdash-test-js`) does not exist in CI. The workflow strips it from `package.json` before install. If other dependencies fail, check the `pnpm-lock.yaml` is committed. |
| Tests pass locally but fail in CI | Check for environment-specific code (file paths, env vars). CI runs on `ubuntu-latest` with Node.js 20. |
| Workflow not triggering | Verify the branch name is `master` (not `main`). Check the workflow file is on the target branch. |
| ElasticDash CI step fails with 401 | Check that `ELASTICDASH_API_URL` and `ELASTICDASH_API_KEY` secrets are configured in the repo. Verify the API key is active (not revoked) in the ElasticDash dashboard. |
| ElasticDash CI finds no test groups | Ensure test groups are set to `active` status in the ElasticDash dashboard. Only active test groups are fetched by the CI runner. |
| ElasticDash CI fails on LLM judge | The `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` secret is missing. Add the relevant provider key for expectations that use `llm-judge`. |
| ElasticDash CI fails with "Cannot find ed_tools" | The `ed_tools.ts` file must exist in the project root. The CI job checks out the repo, so this should work automatically. |
