/**
 * Comprehensive AI workflow tests for sendToPlanner.
 *
 * Covers:
 *   1. Prompt execution order (validator → planner → schema-validator)
 *   2. RAG retrieval correctness (table-pokemon_stats injected into validation)
 *   3. Response structure (execution_plan array, needs_clarification=false)
 *   4. SQL endpoint usage in FETCH plans
 *   5. Actionability metric (LLM judge ≥ 0.7)
 *   6. Semantic output matches the original question
 *   7. Goal-completed shortcut (empty plan when usefulData satisfies goal)
 *   8. No unresolved angle-bracket placeholders in result
 *   9. Schema validator prompt contains the generated plan as context
 */
import { expect } from 'elasticdash-test'
import { sendToPlanner } from './planner'

/** Shared query used across all tests in this file. */
const PIKACHU_ATTACK_QUERY = 'Find the attack of pikachu'

// ─── Test 1: Prompt execution order ─────────────────────────────────────────────
/**
 * The FETCH path makes exactly 3 LLM calls in a fixed sequence:
 *   Step 0 — Goal Completion Validator (openai, nth:1 among query-containing prompts)
 *   Step 3 — Planner (openai, nth:2 among query-containing prompts)
 *   Final  — SQL/schema Validator (openai, nth:1 among schema-validator prompts)
 * Step 1 (kimi intent analysis) is skipped because planIntentType is provided.
 * Step 2 (RAG retrieval) is not an LLM call.
 */
aiTest('sendToPlanner: validator runs before planner in FETCH flow', async (ctx) => {
  await sendToPlanner(PIKACHU_ATTACK_QUERY, '', '', 'FETCH', false)

  // Step 0 — first prompt containing the query must be the Goal Completion Validator
  expect(ctx.trace).toHavePromptWhere({
    filterContains: PIKACHU_ATTACK_QUERY,
    requireContains: 'Goal Completion Validator',
    nth: 1,
  })

  // Step 3 — second prompt containing the query must be the Planner
  expect(ctx.trace).toHavePromptWhere({
    filterContains: PIKACHU_ATTACK_QUERY,
    requireContains: "User's Ultimate Goal:",
    nth: 2,
  })

  // Final — SQL/schema validator is the last LLM call in the workflow
  expect(ctx.trace).toHavePromptWhere({
    filterContains: 'SQL/schema validator',
    requireContains: 'VALIDATION APPROACH:',
    nth: 1,
  })
})

// ─── Test 2: RAG injects correct tables into schema validation ───────────────────
/**
 * Step 2 calls getAllMatchedApis + getTopKResults with the query.
 * For a pikachu attack query the RAG must return pokemon_stats and sql-query.
 * The schema validator receives these as its "Available Table Schemas" context,
 * so all three identifiers must appear in the validation prompt.
 */
aiTest('sendToPlanner: RAG injects table-pokemon_stats into schema validation', async (ctx) => {
  await sendToPlanner(PIKACHU_ATTACK_QUERY, '', '', 'FETCH', false)

  // pokemon_stats schema must be present in the validation context
  expect(ctx.trace).toHavePromptWhere({
    filterContains: 'SQL/schema validator',
    requireContains: 'table-pokemon_stats',
    nth: 1,
  })

  // The sql-query resource descriptor must be present
  expect(ctx.trace).toHavePromptWhere({
    filterContains: 'SQL/schema validator',
    requireContains: 'sql-query',
    nth: 1,
  })

  // The canonical SQL execution endpoint path must appear
  expect(ctx.trace).toHavePromptWhere({
    filterContains: 'SQL/schema validator',
    requireContains: '/general/sql/query',
    nth: 1,
  })
})

// ─── Test 3: Response structure ──────────────────────────────────────────────────
/**
 * The final JSON returned by sendToPlanner must have:
 *   - execution_plan: a non-empty array of steps
 *   - needs_clarification: false (the schema is sufficient to answer the query)
 */
aiTest('sendToPlanner: result has valid non-empty execution_plan structure', async (ctx) => {
  const result = await sendToPlanner(PIKACHU_ATTACK_QUERY, '', '', 'FETCH', false)

  const parsed = JSON.parse(result)
  expect(parsed).toHaveProperty('execution_plan')
  expect(Array.isArray(parsed.execution_plan)).toBe(true)
  expect(parsed.execution_plan.length).toBeGreaterThan(0)
  expect(parsed.needs_clarification).toBe(false)
})

// ─── Test 4: FETCH plan uses SQL endpoint ────────────────────────────────────────
/**
 * FETCH intent plans are SQL-only (no REST mutations).
 * Every step in the execution_plan must reference sql semantics,
 * confirming the planner respected the FETCH constraint.
 */
aiTest('sendToPlanner: FETCH execution_plan steps reference SQL queries', async (ctx) => {
  const result = await sendToPlanner(PIKACHU_ATTACK_QUERY, '', '', 'FETCH', false)

  const parsed = JSON.parse(result)
  const planText = JSON.stringify(parsed.execution_plan).toLowerCase()
  expect(planText).toContain('sql')
})

// ─── Test 5: Plan is actionable (LLM-judged metric) ──────────────────────────────
/**
 * The planner output (nth:2 in the trace — validator is 1st, planner is 2nd)
 * is scored by an LLM judge on a 0–1 actionability scale.
 * A concrete, executable SQL plan should score at least 0.7.
 */
aiTest('sendToPlanner: planner output scores ≥ 0.7 on actionability metric', async (ctx) => {
  await sendToPlanner(PIKACHU_ATTACK_QUERY, '', '', 'FETCH', false)

  await expect(ctx.trace).toEvaluateOutputMetric({
    evaluationPrompt:
      'You are evaluating an AI-generated SQL execution plan. ' +
      'Score it 0.0–1.0 for actionability: ' +
      '1.0 = concrete SQL with real table and column names, executable without modification; ' +
      '0.5 = mostly concrete but missing some field-level specifics; ' +
      '0.0 = vague, uses placeholder values, or cannot be executed as-is. ' +
      'Return only a single number between 0 and 1.',
    target: 'result',
    nth: 2,
    condition: { atLeast: 0.7 },
    provider: 'claude',
    model: 'claude-sonnet-4-6',
  })
})

// ─── Test 6: Semantic output matches the original question ───────────────────────
/**
 * The generated execution plan should semantically describe how to retrieve
 * pikachu's attack base stat. The plan is manually recorded into the trace
 * as a final LLM step so toMatchSemanticOutput can inspect it.
 */
aiTest('sendToPlanner: plan semantically addresses pikachu attack retrieval', async (ctx) => {
  const result = await sendToPlanner(PIKACHU_ATTACK_QUERY, '', '', 'FETCH', false)

  ctx.trace.recordLLMStep({
    model: 'planner',
    prompt: PIKACHU_ATTACK_QUERY,
    completion: result,
  })

  expect(ctx.trace).toMatchSemanticOutput(
    'retrieve the attack base stat for Pikachu using a SQL query',
    { provider: 'claude', model: 'claude-sonnet-4-5-20250929' },
  )
})

// ─── Test 7: Goal-completed shortcut ─────────────────────────────────────────────
/**
 * When usefulData already contains the answer, the Goal Completion Validator
 * returns GOAL_COMPLETED and sendToPlanner short-circuits without calling
 * the planner or schema validator.
 * Expected result: empty execution_plan with a completion message.
 */
aiTest('sendToPlanner: skips planning when usefulData already satisfies the goal', async (ctx) => {
  const usefulData = JSON.stringify([
    { pokemon_name: 'pikachu', stat_name: 'attack', base_stat: 55 },
  ])

  const result = await sendToPlanner(PIKACHU_ATTACK_QUERY, usefulData, '', 'FETCH', false)

  const parsed = JSON.parse(result)
  expect(parsed.execution_plan).toEqual([])
  expect(parsed.needs_clarification).toBe(false)
  expect(parsed.message).toBe('Goal completed with existing data')

  // Only the validator was called — exactly 1 total LLM step
  expect(ctx.trace).toHaveLLMStep({ times: 1 })

  // The planner prompt must never appear in the trace
  expect(ctx.trace).toHaveLLMStep({
    promptContains: "User's Ultimate Goal:",
    maxTimes: 0,
  })
})

// ─── Test 8: No unresolved angle-bracket placeholders ───────────────────────────
/**
 * The correction loop in sendToPlanner explicitly detects `<...>` patterns
 * and forces a retry. The final response must therefore contain no placeholders.
 */
aiTest('sendToPlanner: result contains no angle-bracket placeholder values', async (ctx) => {
  const result = await sendToPlanner(PIKACHU_ATTACK_QUERY, '', '', 'FETCH', false)

  // Patterns like <pokemon_id> or <stat_name> indicate unresolved parameters
  expect(result).not.toMatch(/<[a-zA-Z_][^>]*>/)
})

// ─── Test 9: Schema validator receives the plan as context ───────────────────────
/**
 * The validation prompt is constructed with "Current Plan Response:" followed by
 * the raw planner JSON. Asserting this string confirms the validator actually
 * received the plan and did not run against an empty context.
 */
aiTest('sendToPlanner: schema validation prompt contains the generated plan', async (ctx) => {
  await sendToPlanner(PIKACHU_ATTACK_QUERY, '', '', 'FETCH', false)

  expect(ctx.trace).toHavePromptWhere({
    filterContains: 'SQL/schema validator',
    requireContains: 'Current Plan Response:',
    nth: 1,
  })
})
