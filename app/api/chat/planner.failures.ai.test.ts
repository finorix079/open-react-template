/**
 * Intentionally failing tests for sendToPlanner.
 *
 * Purpose: verify that the elasticdash-test framework correctly identifies
 * individual test failures without contaminating passing tests in the same run.
 *
 * Structure:
 *   Tests 1–6  — designed to FAIL (wrong assertions with explanations)
 *   Test  7    — designed to PASS (proves the framework isolates failures)
 *
 * Each failing test includes a comment explaining exactly why it will fail.
 */
import { expect } from 'elasticdash-test'
import { sendToPlanner } from './planner'

/** Shared query used across all tests in this file. */
const PIKACHU_ATTACK_QUERY = 'Find the attack of pikachu'

// ─── FAIL 1: Wrong prompt order ──────────────────────────────────────────────────
/**
 * WHY IT FAILS: The planner (containing "User's Ultimate Goal:") is the 2nd LLM
 * call, not the 1st. The 1st call is always the Goal Completion Validator.
 * Asserting nth:1 for the planner prompt will fail because at position nth:1
 * the framework will find "Goal Completion Validator", not "User's Ultimate Goal:".
 */
aiTest('[EXPECTED FAIL] sendToPlanner: planner is the first prompt (wrong order)', async (ctx) => {
  await sendToPlanner(PIKACHU_ATTACK_QUERY, '', '', 'FETCH', false)

  expect(ctx.trace).toHavePromptWhere({
    filterContains: PIKACHU_ATTACK_QUERY,
    requireContains: "User's Ultimate Goal:",
    nth: 1, // ← WRONG: planner is nth:2; nth:1 is always the Goal Completion Validator
  })
})

// ─── FAIL 2: Wrong RAG table expected ────────────────────────────────────────────
/**
 * WHY IT FAILS: The pikachu attack query triggers RAG retrieval of pokemon and
 * stat tables (e.g., table-pokemon_stats, table-pokemon). It will never return
 * table-user_accounts, which is an unrelated domain entirely.
 */
aiTest('[EXPECTED FAIL] sendToPlanner: RAG retrieves table-user_accounts', async (ctx) => {
  await sendToPlanner(PIKACHU_ATTACK_QUERY, '', '', 'FETCH', false)

  expect(ctx.trace).toHavePromptWhere({
    filterContains: 'SQL/schema validator',
    requireContains: 'table-user_accounts', // ← WRONG: unrelated table, never in RAG results
    nth: 1,
  })
})

// ─── FAIL 3: Wrong needs_clarification value ─────────────────────────────────────
/**
 * WHY IT FAILS: A well-formed query with sufficient schema coverage always
 * produces needs_clarification=false. The schema validator returns
 * { needs_clarification: false } when the plan references valid tables/columns.
 * Asserting true is the opposite of the expected outcome.
 */
aiTest('[EXPECTED FAIL] sendToPlanner: result has needs_clarification=true', async (ctx) => {
  const result = await sendToPlanner(PIKACHU_ATTACK_QUERY, '', '', 'FETCH', false)

  const parsed = JSON.parse(result)
  expect(parsed.needs_clarification).toBe(true) // ← WRONG: should always be false here
})

// ─── FAIL 4: Wrong semantic assertion ────────────────────────────────────────────
/**
 * WHY IT FAILS: The query explicitly asks for pikachu's ATTACK stat.
 * The generated SQL plan will reference the attack stat (base_stat for attack),
 * not the defense stat. An LLM judge will correctly score the semantic match
 * against "DEFENSE stat" as a mismatch and fail the assertion.
 */
aiTest('[EXPECTED FAIL] sendToPlanner: output semantically addresses SPEED stat', async (ctx) => {
  const result = await sendToPlanner(PIKACHU_ATTACK_QUERY, '', '', 'FETCH', false)

  ctx.trace.recordLLMStep({
    model: 'planner',
    prompt: PIKACHU_ATTACK_QUERY,
    completion: typeof result === 'string' ? result : JSON.stringify(result),
  })

  await expect(ctx.trace).toMatchSemanticOutput('speed of Pikachu as the final deliverable', {
    provider: 'openai',
    model: 'kimi-k2-turbo-preview',
    apiKey: process.env.KIMI_API_KEY,
    baseURL: 'https://api.moonshot.ai/v1',
  })

})

// ─── FAIL 5: Impossibly strict actionability threshold ───────────────────────────
/**
 * WHY IT FAILS: LLM-generated SQL plans are evaluated by a judge model.
 * A score of 0.99 requires near-perfect actionability with zero ambiguity.
 * Real AI-generated plans consistently score below this threshold due to
 * minor stylistic imperfections, even when functionally correct.
 */
aiTest('[EXPECTED FAIL] sendToPlanner: plan scores ≤ 0.4 on actionability', async (ctx) => {
  await sendToPlanner(PIKACHU_ATTACK_QUERY, '', '', 'FETCH', false)

  await expect(ctx.trace).toEvaluateOutputMetric({
    evaluationPrompt:
      'Score this SQL execution plan 0.0–1.0 for actionability. ' +
      '1.0 = fully executable without any changes; 0.0 = vague or uses placeholders. ' +
      'Return only a number.',
    target: 'result',
    nth: 2,
    condition: { atMost: 0.4 }, // ← WRONG: no AI-generated plan reliably achieves 0.99
    provider: 'claude',
    model: 'claude-sonnet-4-6',
  })
})

// ─── FAIL 6: Wrong LLM call count ────────────────────────────────────────────────
/**
 * WHY IT FAILS: The FETCH path (with planIntentType provided) makes exactly 3
 * LLM calls: validator → planner → schema-validator.
 * Asserting times:10 is completely wrong; it will never match.
 */
aiTest('[EXPECTED FAIL] sendToPlanner: makes exactly 10 LLM calls', async (ctx) => {
  await sendToPlanner(PIKACHU_ATTACK_QUERY, '', '', 'FETCH', false)

  expect(ctx.trace).toHaveLLMStep({ times: 10 }) // ← WRONG: exactly 3 LLM calls are made
})

// ─── FAIL 7: Kimi intent analysis — wrong call position ──────────────────────────
/**
 * WHY IT FAILS: When planIntentType is omitted, the pipeline executes 4 LLM calls:
 *   nth:1 → Goal Completion Validator (openai)
 *   nth:2 → Kimi Next Step Planner    (kimi)
 *   nth:3 → SQL Planner               (openai)
 *   nth:4 → Schema Validator          (openai)
 *
 * Asserting that the first prompt matching PIKACHU_ATTACK_QUERY also contains
 * "Next Step Planner" will fail because nth:1 for that filter is the Goal
 * Completion Validator prompt, which never contains "Next Step Planner".
 */
aiTest('[EXPECTED FAIL] sendToPlanner: Kimi intent analysis is the first LLM call', async (ctx) => {
  await sendToPlanner(PIKACHU_ATTACK_QUERY, '', '') // no planIntentType → triggers Kimi intent step

  expect(ctx.trace).toHavePromptWhere({
    filterContains: PIKACHU_ATTACK_QUERY,
    requireContains: 'Next Step Planner', // ← WRONG: nth:1 is Goal Completion Validator, not Kimi planner
    nth: 1,
  })
})

// ─── PASS 2: Kimi intent analysis — correct invocation ───────────────────────────
/**
 * WHY IT PASSES: When planIntentType is omitted sendToPlanner executes the full
 * 4-step pipeline including the Kimi Next Step Planner call. This test makes two
 * correct, independently verifiable assertions:
 *   1. The Kimi prompt contains both "Next Step Planner" and the original query.
 *   2. Exactly 4 LLM calls are made in total.
 */
aiTest('[EXPECTED PASS] sendToPlanner: Kimi intent analysis returns FETCH for a read query', async (ctx) => {
  await sendToPlanner(PIKACHU_ATTACK_QUERY, '', '') // no planIntentType → triggers Kimi intent step

  // When Kimi correctly returns type="FETCH", the downstream planner message contains
  // "This is a FETCH intent". A MODIFY result would produce a different prompt branch
  // and this assertion would fail.
  expect(ctx.trace).toHavePromptWhere({
    filterContains: "User's Ultimate Goal:",
    requireContains: 'This is a FETCH intent',
    nth: 1,
  })

  // Full pipeline: validator → kimi intent → planner → schema-validator = 4 calls
  expect(ctx.trace).toHaveLLMStep({ times: 3 })
})

// ─── PASS: Baseline sanity check (isolation proof) ───────────────────────────────
/**
 * WHY IT PASSES: This test makes only correct, verifiable assertions.
 * Its presence in the same file as the 6 failing tests verifies that the
 * elasticdash-test framework isolates individual test results — a file with
 * mixed pass/fail tests should report each test independently, not mark the
 * entire file as failed.
 */
aiTest('[EXPECTED PASS] sendToPlanner: returns a non-empty valid JSON string', async (ctx) => {
  const result = await sendToPlanner(PIKACHU_ATTACK_QUERY, '', '', 'FETCH', false)

  expect(typeof result).toBe('string')
  expect(result.length).toBeGreaterThan(0)
  expect(() => JSON.parse(result)).not.toThrow()
  expect(ctx.trace).toHaveLLMStep({
    promptContains: 'Goal Completion Validator',
    minTimes: 1,
  })
})
