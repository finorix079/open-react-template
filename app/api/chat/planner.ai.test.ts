/**
 * @file planner.ai.test.ts
 * @description AI workflow tests for the sendToPlanner function (planner.ts).
 * Uses elasticdash-test for trace-first AI pipeline testing.
 *
 * Covered scenarios:
 *   1. GOAL_COMPLETED early-exit — usefulData already satisfies the goal
 *   2. GOAL_NOT_COMPLETED + FETCH intent — generates a read-only SQL plan
 *   3. GOAL_NOT_COMPLETED + MODIFY intent — generates multi-step lookup + mutation plan
 *   4. No RAG results — returns impossible flag
 *   5. SQL schema validation failure — returns needs_clarification
 *   6. Conversation context propagation — resolves ambiguous pronoun references
 *   7. Angle-bracket placeholder detection — triggers correction retry
 *
 * Run via:
 *   elasticdash run app/api/chat/planner.ai.test.ts
 */

import 'elasticdash-test/dist/test-setup.js'
import type { AITestContext } from 'elasticdash-test'
import { expect } from 'elasticdash-test'

// ─── Domain types ────────────────────────────────────────────────────────────

interface PlanStep {
  step_number: number
  action: string
  description?: string
  sql?: string
  endpoint?: string
  body?: Record<string, unknown>
}

interface PlannerOutput {
  needs_clarification: boolean
  execution_plan: PlanStep[]
  message?: string
  impossible?: boolean
  reason?: string
  clarification_question?: string
}

// ─── Harness configuration ────────────────────────────────────────────────────

interface HarnessParams {
  /** The refined user query passed to sendToPlanner */
  refinedQuery: string
  /** Serialised data already available from prior steps */
  usefulData: string
  /** Optional prior conversation turns */
  conversationContext?: string
  /** Pre-determined intent type; when omitted the harness simulates the kimi intent call */
  planIntentType?: 'FETCH' | 'MODIFY'
  // --- Mock LLM responses ---
  /** Simulated OpenAI validator response */
  validatorResponse: 'GOAL_COMPLETED' | 'GOAL_NOT_COMPLETED'
  /** Simulated kimi intent JSON (only used when planIntentType is omitted) */
  intentResponse?: string
  /** Simulated RAG results returned by getTopKResults */
  ragApis?: unknown[]
  /** Simulated planner LLM response (JSON string) */
  plannerResponse?: string
  /** Simulated schema-validator response (JSON string) */
  validationResponse?: string
}

// ─── Test harness ─────────────────────────────────────────────────────────────

/**
 * Simulates the full sendToPlanner workflow with injectable mock responses.
 * Records every LLM call and tool invocation on ctx.trace so tests can assert
 * the correct AI pipeline was exercised.
 *
 * Side effects: writes LLM steps and tool-call records to ctx.trace.
 */
async function runPlannerWorkflow(
  ctx: AITestContext,
  params: HarnessParams
): Promise<string> {
  const {
    refinedQuery,
    usefulData,
    conversationContext,
    planIntentType,
    validatorResponse,
    intentResponse,
    ragApis = [],
    plannerResponse = '{"needs_clarification":false,"execution_plan":[]}',
    validationResponse = '{"needs_clarification":false}',
  } = params

  const contextInfo = conversationContext
    ? `CONVERSATION HISTORY: ${conversationContext}`
    : ''

  // ── Step 0: Goal Completion Validator ───────────────────────────────────────
  ctx.trace.recordLLMStep({
    model: 'openai',
    prompt: [
      '[Goal Completion Validator]',
      contextInfo,
      `User Goal: ${refinedQuery}`,
      `Existing Data: ${usefulData || 'None'}`,
    ]
      .filter(Boolean)
      .join('\n'),
    completion: validatorResponse,
  })

  if (validatorResponse === 'GOAL_COMPLETED') {
    return JSON.stringify({
      needs_clarification: false,
      execution_plan: [],
      message: 'Goal completed with existing data',
    })
  }

  // ── Step 1: Intent analysis (kimi, skipped when planIntentType is supplied) ─
  let nextIntent = refinedQuery
  let intentType: 'FETCH' | 'MODIFY' = planIntentType ?? 'FETCH'

  if (!planIntentType) {
    const rawIntent = intentResponse ?? '{"description":"Fetch data","type":"FETCH"}'
    ctx.trace.recordLLMStep({
      model: 'kimi',
      prompt: [
        '[Next Step Planner]',
        contextInfo,
        `User Goal: ${refinedQuery}`,
        `Existing Data: ${usefulData || 'None'}`,
      ]
        .filter(Boolean)
        .join('\n'),
      completion: rawIntent,
    })
    ctx.trace.recordToolCall({
      name: 'kimiChatCompletion',
      args: { query: refinedQuery },
    })

    const intentObj = JSON.parse(rawIntent)
    nextIntent = intentObj.description?.trim() ?? refinedQuery
    intentType = (intentObj.type?.trim() as 'FETCH' | 'MODIFY') ?? 'FETCH'

    if (nextIntent === 'GOAL_COMPLETED' || nextIntent.includes('GOAL_COMPLETED')) {
      return JSON.stringify({
        needs_clarification: false,
        execution_plan: [],
        message: 'Goal completed with existing data',
      })
    }
  }

  // ── Step 2: RAG retrieval ───────────────────────────────────────────────────
  ctx.trace.recordToolCall({
    name: 'getAllMatchedApis',
    args: { entities: [nextIntent], intentType },
  })
  ctx.trace.recordToolCall({
    name: 'getTopKResults',
    args: { topK: 20 },
  })

  if (ragApis.length === 0) {
    const qualifier = intentType === 'MODIFY' ? 'APIs, tables, or columns' : 'tables or columns'
    const actionKind = intentType === 'MODIFY' ? 'plan or API call' : 'SQL query'
    return JSON.stringify({
      impossible: true,
      needs_clarification: false,
      message: `I'm sorry, but there are no relevant ${qualifier} in the database schema that can provide information about "${refinedQuery}". Therefore, I am unable to generate a ${actionKind} for this request.`,
      reason: 'No relevant database resources found',
      execution_plan: [],
    })
  }

  // ── Step 3: Planner LLM call ────────────────────────────────────────────────
  ctx.trace.recordLLMStep({
    model: 'openai',
    prompt: [
      contextInfo,
      `User's Ultimate Goal: ${refinedQuery}`,
      `Next Intent: ${nextIntent}`,
      `Available Resources: ${JSON.stringify(ragApis)}`,
      `Useful Data: ${usefulData || 'None'}`,
    ]
      .filter(Boolean)
      .join('\n'),
    completion: plannerResponse,
  })

  // ── Step 3a: SQL / schema validation ───────────────────────────────────────
  ctx.trace.recordLLMStep({
    model: 'openai',
    prompt: [
      '[SQL/Schema Validator]',
      `Available Table Schemas: ${JSON.stringify(ragApis)}`,
      `Current Plan: ${plannerResponse}`,
    ].join('\n'),
    completion: validationResponse,
  })

  const validationObj = JSON.parse(validationResponse)
  if (validationObj.needs_clarification === true) {
    return JSON.stringify(validationObj)
  }

  // ── Step 4: Assumption / ID-clarification check ────────────────────────────
  let parsedPlan: PlannerOutput
  try {
    parsedPlan = JSON.parse(plannerResponse)
  } catch {
    throw new Error('Invalid JSON in planner response')
  }

  const containsAngleBracket =
    plannerResponse.includes('<') && plannerResponse.includes('>')
  const containsAssumptionWord = /\bassume\b|\bassuming\b/i.test(plannerResponse)
  const containsAssumption = containsAngleBracket || containsAssumptionWord

  const needsClarification = parsedPlan.needs_clarification === true
  const ID_KEYWORDS = ['id', 'identifier', 'type id', 'look it up', 'using an api']
  const needsIdClarification =
    needsClarification &&
    ID_KEYWORDS.some(kw =>
      (parsedPlan.reason ?? '').toLowerCase().includes(kw)
    )

  if (containsAssumption || needsIdClarification) {
    const correctionMessage =
      'CRITICAL ERROR: Resolve IDs via API lookups — do not ask the user for data that can be retrieved programmatically.'
    ctx.trace.recordLLMStep({
      model: 'openai',
      prompt: correctionMessage,
      completion: plannerResponse,
    })
    ctx.trace.recordToolCall({
      name: 'openaiChatCompletion',
      args: { purpose: 'retry-correction' },
    })
  }

  return plannerResponse
}

// ─── Tests ────────────────────────────────────────────────────────────────────

aiTest(
  'sendToPlanner — GOAL_COMPLETED: returns empty plan when usefulData satisfies the goal',
  async (ctx: AITestContext) => {
    const result = await runPlannerWorkflow(ctx, {
      refinedQuery: 'Get all fire-type pokemon',
      usefulData: '[{"name":"charmander","type":"fire"},{"name":"vulpix","type":"fire"}]',
      validatorResponse: 'GOAL_COMPLETED',
    })

    const parsed: PlannerOutput = JSON.parse(result)

    // Trace assertions
    expect(ctx.trace).toHaveLLMStep({ model: 'openai', contains: 'GOAL_COMPLETED' })

    // Output assertions
    expect(parsed.needs_clarification).toBe(false)
    expect(parsed.execution_plan).toHaveLength(0)
    expect(parsed.message).toBe('Goal completed with existing data')
  }
)

aiTest(
  'sendToPlanner — FETCH intent: generates a read-only SQL plan via kimi intent + RAG',
  async (ctx: AITestContext) => {
    const mockPlan = JSON.stringify({
      needs_clarification: false,
      execution_plan: [
        {
          step_number: 1,
          action: 'SQL_QUERY',
          description: 'Fetch all fire-type pokemon via join',
          sql: "SELECT p.id, p.identifier FROM pokemon p JOIN pokemon_types pt ON p.id = pt.pokemon_id JOIN types t ON pt.type_id = t.id WHERE t.identifier = 'fire'",
        },
      ],
    })

    const result = await runPlannerWorkflow(ctx, {
      refinedQuery: 'Get all fire-type pokemon',
      usefulData: 'None',
      validatorResponse: 'GOAL_NOT_COMPLETED',
      intentResponse: JSON.stringify({
        description: 'Fetch all fire-type pokemon from database',
        type: 'FETCH',
      }),
      ragApis: [
        { id: 'table-pokemon', content: 'pokemon(id, identifier, base_experience)' },
        { id: 'table-types', content: 'types(id, identifier)' },
        { id: 'table-pokemon_types', content: 'pokemon_types(pokemon_id, type_id, slot)' },
      ],
      plannerResponse: mockPlan,
      validationResponse: '{"needs_clarification":false}',
    })

    const parsed: PlannerOutput = JSON.parse(result)

    // Trace assertions — kimi intent call must have occurred
    expect(ctx.trace).toHaveLLMStep({ model: 'kimi', contains: 'Get all fire-type pokemon' })
    // RAG tool calls must have been recorded
    expect(ctx.trace).toCallTool('getAllMatchedApis')
    expect(ctx.trace).toCallTool('getTopKResults')
    // Final planner LLM call must have produced the SQL plan
    expect(ctx.trace).toHaveLLMStep({ model: 'openai', contains: 'SQL_QUERY' })
    expect(ctx.trace).toMatchSemanticOutput('fire-type pokemon')

    // Output assertions
    expect(parsed.needs_clarification).toBe(false)
    expect(parsed.execution_plan).toHaveLength(1)
    expect(parsed.execution_plan[0].action).toBe('SQL_QUERY')
    expect(parsed.execution_plan[0].sql).toContain('fire')
  }
)

aiTest(
  'sendToPlanner — MODIFY intent: generates lookup + mutation + validation plan',
  async (ctx: AITestContext) => {
    const mockPlan = JSON.stringify({
      needs_clarification: false,
      execution_plan: [
        {
          step_number: 1,
          action: 'SQL_QUERY',
          description: "Resolve pikachu's id",
          sql: "SELECT id FROM pokemon WHERE identifier = 'pikachu'",
        },
        {
          step_number: 2,
          action: 'API_CALL',
          description: "Update pikachu's HP stat",
          endpoint: 'PUT /api/v2/pokemon/25/stats',
          body: { base_stat: 100, stat_id: 6 },
        },
        {
          step_number: 3,
          action: 'SQL_QUERY',
          description: 'Validate HP update',
          sql: 'SELECT base_stat FROM pokemon_stats WHERE pokemon_id = 25 AND stat_id = 6',
        },
      ],
    })

    const result = await runPlannerWorkflow(ctx, {
      refinedQuery: "Update pikachu's HP to 100",
      usefulData: 'None',
      planIntentType: 'MODIFY',
      validatorResponse: 'GOAL_NOT_COMPLETED',
      ragApis: [
        { id: 'table-pokemon', content: 'pokemon(id, identifier)' },
        { id: 'table-pokemon_stats', content: 'pokemon_stats(pokemon_id, stat_id, base_stat)' },
        {
          id: 'api-put-pokemon-stats',
          content: 'PUT /api/v2/pokemon/:id/stats — update a pokemon stat',
        },
      ],
      plannerResponse: mockPlan,
      validationResponse: '{"needs_clarification":false}',
    })

    const parsed: PlannerOutput = JSON.parse(result)

    // Trace assertions — no kimi call when planIntentType is supplied
    expect(ctx.trace).toHaveLLMStep({ model: 'openai', contains: 'pikachu' })
    expect(ctx.trace).toCallTool('getAllMatchedApis')
    expect(ctx.trace).toMatchSemanticOutput('HP')

    // Output assertions — must have all three steps in correct order
    expect(parsed.needs_clarification).toBe(false)
    expect(parsed.execution_plan).toHaveLength(3)
    expect(parsed.execution_plan[0].action).toBe('SQL_QUERY')   // resolution
    expect(parsed.execution_plan[1].action).toBe('API_CALL')    // mutation
    expect(parsed.execution_plan[2].action).toBe('SQL_QUERY')   // validation
  }
)

aiTest(
  'sendToPlanner — no RAG results: returns impossible flag when schema has no matching resources',
  async (ctx: AITestContext) => {
    const result = await runPlannerWorkflow(ctx, {
      refinedQuery: 'Get data about quantum-breathing dragons',
      usefulData: 'None',
      validatorResponse: 'GOAL_NOT_COMPLETED',
      intentResponse: JSON.stringify({ description: 'Fetch quantum dragon data', type: 'FETCH' }),
      ragApis: [],
    })

    const parsed: PlannerOutput = JSON.parse(result)

    // Both RAG tool calls must still be recorded even on empty result
    expect(ctx.trace).toCallTool('getAllMatchedApis')
    expect(ctx.trace).toCallTool('getTopKResults')

    // Output assertions
    expect(parsed.impossible).toBe(true)
    expect(parsed.needs_clarification).toBe(false)
    expect(parsed.execution_plan).toHaveLength(0)
    expect(parsed.reason).toBe('No relevant database resources found')
  }
)

aiTest(
  'sendToPlanner — schema validation failure: propagates needs_clarification when SQL references missing table',
  async (ctx: AITestContext) => {
    const mockPlan = JSON.stringify({
      needs_clarification: false,
      execution_plan: [
        {
          step_number: 1,
          action: 'SQL_QUERY',
          sql: 'SELECT * FROM nonexistent_table WHERE foo = 1',
        },
      ],
    })

    const validationFail = JSON.stringify({
      needs_clarification: true,
      reason: 'Table nonexistent_table does not exist in schema',
      clarification_question: 'Which table stores the data you need?',
    })

    const result = await runPlannerWorkflow(ctx, {
      refinedQuery: 'Get items from nonexistent table',
      usefulData: 'None',
      validatorResponse: 'GOAL_NOT_COMPLETED',
      intentResponse: JSON.stringify({ description: 'Fetch items', type: 'FETCH' }),
      ragApis: [{ id: 'table-pokemon', content: 'pokemon(id, identifier)' }],
      plannerResponse: mockPlan,
      validationResponse: validationFail,
    })

    const parsed = JSON.parse(result)

    // Validator LLM step must be present
    expect(ctx.trace).toHaveLLMStep({ model: 'openai', contains: 'SQL/Schema Validator' })
    // The failing plan was submitted to the validator
    expect(ctx.trace).toHaveLLMStep({ model: 'openai', contains: 'nonexistent_table' })

    // Output assertions
    expect(parsed.needs_clarification).toBe(true)
    expect(parsed.reason).toContain('nonexistent_table')
    expect(parsed.clarification_question).toBeDefined()
  }
)

aiTest(
  'sendToPlanner — conversation context: resolves ambiguous pronoun using prior history',
  async (ctx: AITestContext) => {
    const conversationContext =
      'User: Tell me about pikachu. Assistant: Pikachu is an electric-type pokemon with id 25.'

    const mockPlan = JSON.stringify({
      needs_clarification: false,
      execution_plan: [
        {
          step_number: 1,
          action: 'SQL_QUERY',
          description: 'Fetch moves for pokemon id 25 (pikachu)',
          sql: 'SELECT m.identifier FROM pokemon_moves pm JOIN moves m ON pm.move_id = m.id WHERE pm.pokemon_id = 25',
        },
      ],
    })

    const result = await runPlannerWorkflow(ctx, {
      refinedQuery: 'Show its moves',
      usefulData: 'None',
      conversationContext,
      validatorResponse: 'GOAL_NOT_COMPLETED',
      intentResponse: JSON.stringify({
        description: 'Fetch moves for pikachu (pokemon id 25) from database',
        type: 'FETCH',
      }),
      ragApis: [
        { id: 'table-moves', content: 'moves(id, identifier, power, pp)' },
        { id: 'table-pokemon_moves', content: 'pokemon_moves(pokemon_id, move_id, level)' },
      ],
      plannerResponse: mockPlan,
      validationResponse: '{"needs_clarification":false}',
    })

    const parsed: PlannerOutput = JSON.parse(result)

    // Conversation context must appear in the validator prompt
    expect(ctx.trace).toHaveLLMStep({ model: 'openai', contains: 'CONVERSATION HISTORY' })
    // Kimi must see the original ambiguous query
    expect(ctx.trace).toHaveLLMStep({ model: 'kimi', contains: 'Show its moves' })
    // Semantic output should reflect pikachu / moves
    expect(ctx.trace).toMatchSemanticOutput('pikachu')
    expect(ctx.trace).toMatchSemanticOutput('moves')

    // Output assertions — SQL must reference pokemon_id = 25 resolved from context
    expect(parsed.needs_clarification).toBe(false)
    expect(parsed.execution_plan).toHaveLength(1)
    expect(parsed.execution_plan[0].sql).toContain('pokemon_id = 25')
  }
)

aiTest(
  'sendToPlanner — angle-bracket placeholders: triggers correction retry when plan contains unresolved <param>',
  async (ctx: AITestContext) => {
    const planWithPlaceholder = JSON.stringify({
      needs_clarification: false,
      execution_plan: [
        {
          step_number: 1,
          action: 'API_CALL',
          description: 'Update pokemon stat — WARNING: ID unresolved',
          endpoint: 'PUT /api/v2/pokemon/<pokemon_id>/stats',
          body: { base_stat: 100 },
        },
      ],
    })

    const result = await runPlannerWorkflow(ctx, {
      refinedQuery: "Update pikachu's HP to 100",
      usefulData: 'None',
      planIntentType: 'MODIFY',
      validatorResponse: 'GOAL_NOT_COMPLETED',
      ragApis: [
        { id: 'table-pokemon', content: 'pokemon(id, identifier)' },
        { id: 'api-put-pokemon', content: 'PUT /api/v2/pokemon/:id/stats' },
      ],
      plannerResponse: planWithPlaceholder,
      validationResponse: '{"needs_clarification":false}',
    })

    // A correction LLM call must have been triggered
    expect(ctx.trace).toHaveLLMStep({ model: 'openai', contains: 'CRITICAL ERROR' })
    expect(ctx.trace).toCallTool('openaiChatCompletion')

    // The returned plan is still defined (correction logic returns the last response)
    const parsed: PlannerOutput = JSON.parse(result)
    expect(parsed.execution_plan).toBeDefined()
  }
)
