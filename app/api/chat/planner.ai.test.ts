import { expect } from 'elasticdash-test'
import { sendToPlanner } from './planner'

aiTest('sendToPlanner returns a plan for a simple goal', async (ctx) => {
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

  // Use trace-aware matcher for semantic output
  expect(ctx.trace).toMatchSemanticOutput('attack of Pikachu')
})