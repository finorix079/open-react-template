import { expect } from 'elasticdash-test'
import { sendToPlanner } from './planner'

aiTest('sendToPlanner calls prompts in the correct order for a FETCH goal', async (ctx) => {
  const refinedQuery = 'Find the attack of pikachu'
  const usefulData = ''
  const conversationContext = ''

  await sendToPlanner(refinedQuery, usefulData, conversationContext, 'FETCH', false)

  // Step 0 must be first: Goal Completion Validator evaluates whether existing data satisfies the goal
  expect(ctx.trace).toHavePromptWhere({
    filterContains: refinedQuery,
    requireContains: 'Goal Completion Validator',
    nth: 1,
  })

  // Check if the correct information is included in the validation prompt
  expect(ctx.trace).toHavePromptWhere({
    filterContains: 'SQL/schema validator',
    requireContains: 'VALIDATION APPROACH:',
    nth: 1,
  })

  expect(ctx.trace).toHavePromptWhere({
    filterContains: 'SQL/schema validator',
    requireContains: 'table-pokemon_stats',
    nth: 1,
  })

  expect(ctx.trace).toHavePromptWhere({
    filterContains: 'SQL/schema validator',
    requireContains: '/general/sql/query',
    nth: 1,
  })

  expect(ctx.trace).toHavePromptWhere({
    filterContains: 'SQL/schema validator',
    requireContains: 'sql-query',
    nth: 1,
  })

  // Step 3 must be second: Planner generates the execution plan
  // (Step 1 intent analysis is skipped because planIntentType='FETCH' is provided;
  //  Step 2 is RAG retrieval with no LLM call)
  expect(ctx.trace).toHavePromptWhere({
    filterContains: refinedQuery,
    requireContains: "User's Ultimate Goal:",
    nth: 2,
  })
})

aiTest('[EXPECTED FAIL] sendToPlanner returns a plan for a simple goal', async (ctx) => {
  const refinedQuery = 'Find the attack of pikachu'
  const usefulData = ''
  const conversationContext = ''

  const result = await sendToPlanner(refinedQuery, usefulData, conversationContext, 'FETCH', false)

  // Record the LLM output into the trace so trace-aware matchers can inspect the output
  ctx.trace.recordLLMStep({
    model: 'unknown', // Use actual model name if available
    completion: typeof result === 'string' ? result : JSON.stringify(result),
    prompt: refinedQuery,
  })

  // Parse the result if it's a JSON string
  let parsedResult
  try {
    parsedResult = JSON.parse(result)
  } catch {
    parsedResult = result
  }

  // Assert the structure of the result
  expect(parsedResult).toHaveProperty('execution_plan')
  expect(Array.isArray(parsedResult.execution_plan)).toBe(true)
  expect(parsedResult.needs_clarification).toBe(false)
  expect(ctx.trace).toHaveLLMStep({ promptContains: "User's Ultimate Goal:", minTimes: 1 })

  // Use trace-aware matcher for semantic output
  await expect(ctx.trace).toMatchSemanticOutput('attack of Pikachu as the final deliverable');
  // Where the error occurs
  await expect(ctx.trace).toMatchSemanticOutput('defense of Pikachu as the final deliverable', { provider: 'claude', model: 'claude-sonnet-4-6' })
  await expect(ctx.trace).toMatchSemanticOutput('attack of Pikachu as the final deliverable', { provider: 'claude', model: 'claude-sonnet-4-5-20250929' })
  await expect(ctx.trace).toMatchSemanticOutput('attack of Pikachu as the final deliverable', {
    provider: 'openai',
    model: 'kimi-k2-turbo-preview',
    apiKey: process.env.KIMI_API_KEY,
    baseURL: 'https://api.moonshot.ai/v1',
  })
})

aiTest('sendToPlanner generates a plan that provides clear detail', async (ctx) => {
  const refinedQuery = 'Find the attack of pikachu'
  const usefulData = ''
  const conversationContext = ''

  await sendToPlanner(refinedQuery, usefulData, conversationContext, 'FETCH', false)

  // Evaluate whether the planner output (2nd LLM call: validator=1, planner=2, schema-validator=3)
  // is actionable — i.e. contains concrete, directly executable SQL rather than vague instructions.
  await expect(ctx.trace).toEvaluateOutputMetric({
    evaluationPrompt:
      'You are evaluating an AI-generated SQL execution plan. ' +
      'Score it from 0.0 to 1.0 based on actionability: ' +
      '1.0 = the plan contains concrete SQL queries with specific table names, column names, ' +
      'and conditions that can be executed directly without modification; ' +
      '0.5 = the plan is mostly concrete but missing some specifics; ' +
      '0.0 = the plan is vague, uses placeholder values, or cannot be executed as-is. ' +
      'Return only a single number between 0 and 1.',
    target: 'result',
    nth: 2,
    condition: { atLeast: 0.5 },
    // condition: { atMost: 0.3 },
    provider: 'claude',
    model: 'claude-sonnet-4-6',
  })
})