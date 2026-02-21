import { expect } from 'elasticdash-test'
import { sendToPlanner } from './planner'

aiTest('sendToPlanner returns a plan for a simple goal', async (ctx) => {
  const refinedQuery = 'Find all users with status active'
  const usefulData = '' // or some mock data
  const conversationContext = ''

  const result = await sendToPlanner(refinedQuery, usefulData, conversationContext, 'FETCH', false)

  // Parse the result if it's a JSON string
  let parsedResult
  try {
    parsedResult = JSON.parse(result)
  } catch {
    parsedResult = result
  }

  // Example assertion: check that execution_plan exists and is an array
  expect(parsedResult).toHaveProperty('execution_plan')
  expect(Array.isArray(parsedResult.execution_plan)).toBe(true)

  // Example semantic assertion
  expect(result).toMatchSemanticOutput('execution_plan')
})
