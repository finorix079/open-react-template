/**
 * validators.ts
 * Functions for validating intent type and goal completion status.
 */
import { kimiChatCompletion, aiGenerateObject } from '@/utils/aiHandler';
import { NeedMoreActionsSchema } from '@/schemas/ai';

/**
 * Classifies whether a query/plan is a resolution (read-only check) or an execution (mutation).
 */
export async function detectResolutionVsExecution(
  refinedQuery: string,
  executionPlan: any,
  apiKey: string
): Promise<'resolution' | 'execution'> {
  try {
    const intent = await kimiChatCompletion({
      messages: [
        {
          role: 'system',
          content: `You are a query intent classifier.

RESOLUTION queries are those that:
- Check, verify, or confirm the current state
- Ask "has X been done?", "is Y cleared?", "how many Z?"
- Retrieve information to verify a previous action
- Query the database to check current state
- Examples: "Has the watchlist been cleared?", "Did the deletion succeed?", "Show current state", "How many items in my team?"

EXECUTION queries are those that:
- Perform actions or modifications
- Add, delete, update, create data
- Directly call modification APIs
- Examples: "Clear the watchlist", "Delete this item", "Add to team"

Respond with ONLY ONE WORD: either "resolution" or "execution"`,
        },
        {
          role: 'user',
          content: `Query: ${refinedQuery}

Execution Plan: ${JSON.stringify(executionPlan, null, 2)}

Intent:`,
        },
      ],
      temperature: 0.1,
      max_tokens: 10,
    });
    const result = intent?.trim().toLowerCase();
    console.log(`🔍 Detected intent: ${result} for query: "${refinedQuery}"`);
    if (result === 'resolution') {
      return 'resolution';
    }
    return 'execution';
  } catch (error) {
    console.error('Error detecting resolution vs execution:', error);
    return 'execution';
  }
}

/**
 * Validates whether more API actions are needed to complete the original user goal.
 * Returns a decision with reasoning and optional next-action suggestion.
 */
export async function validateNeedMoreActions(
  originalQuery: string,
  executedSteps: any[],
  accumulatedResults: any[],
  apiKey: string,
  lastExecutionPlan?: any
): Promise<{
  needsMoreActions: boolean;
  reason: string;
  missing_requirements?: string[];
  suggested_next_action?: string;
  useful_data?: string;
  item_not_found?: boolean;
}> {
  try {
    const systemPrompt = `You are the VALIDATOR.

Your ONLY responsibility is to determine whether
the ORIGINAL USER GOAL has been fully satisfied.

You do NOT care whether:
- an API call succeeded
- a step executed without error
- the current execution plan has no remaining steps

You ONLY care about:
→ whether the user's original intent is fulfilled in the current world state.

────────────────────────────────────────
CORE PRINCIPLE (NON-NEGOTIABLE)
────────────────────────────────────────

A successful API call ≠ task completion.

An empty execution plan ≠ task completion.

Only the satisfaction of the ORIGINAL USER GOAL
determines completion.

────────────────────────────────────────
INPUTS YOU WILL RECEIVE
────────────────────────────────────────

You are given:

1. original_user_query (immutable)
2. canonical_user_goal (normalized form, if available)
3. execution_history (all executed API calls + responses)
4. world_state (accumulated facts inferred from execution)
5. last_execution_plan (may be incomplete or incorrect)

You MUST evaluate completion ONLY against (1) or (2).

────────────────────────────────────────
ABSOLUTE RULES
────────────────────────────────────────

1. You MUST NOT infer or invent a new goal.
2. You MUST NOT replace the user goal with a planner step description.
3. You MUST NOT assume the planner plan was complete or correct.
4. You MUST NOT conclude completion solely because:
   - an API returned success
   - data was retrieved
   - no remaining steps exist

If the user goal implies a state change,
you MUST verify that the state change has occurred.

────────────────────────────────────────
GOAL SATISFACTION CHECK (MANDATORY)
────────────────────────────────────────

You MUST answer the following questions IN ORDER:

1. What is the user's original intent?
2. What observable state change or final answer would satisfy it?
3. Does the current world_state conclusively show that state?

If the answer to (3) is NO or UNCERTAIN:
→ the task is NOT complete.

Uncertainty MUST be treated as NOT COMPLETE.

────────────────────────────────────────
COMMON GOAL PATTERNS (GUIDELINES)
────────────────────────────────────────

A) Information retrieval goals
   (e.g. "Which Pokémon has the highest Attack?")
   → Completion requires:
     - a final answer derived from data
     - not just raw data retrieval

B) State-changing goals
   (e.g. "Add Aggron to my watchlist")
   → Completion requires:
     - confirmation that the state changed
     - e.g. POST success AND/OR watchlist contains the ID

C) Multi-step goals
   → Completion requires:
     - ALL required sub-actions completed
     - Partial progress is NOT sufficient

────────────────────────────────────────
CRITICAL: NO RESULTS / NOT FOUND DETECTION
────────────────────────────────────────

If a search/query API call returns:
- Empty array/list (length = 0)
- null result
- "not found" message
- 404 status code
- Error indicating item doesn't exist

AND the user is searching for a specific item by name/identifier:

FIRST, check if there is ANY related data in Accumulated Results:
- If related data exists (e.g., moves for "zygarde" when searching "zygarde-mega")
- If useful information was found with similar identifiers
- If the conversation context referenced a variant that exists

→ DO NOT trigger "item_not_found"
→ USE the related/variant data that was found
→ Conclude: needsMoreActions = false (but with reason explaining the variant was used)

ONLY IF no related data exists at all:
→ The item DOES NOT EXIST in the system
→ DO NOT request more searches with different variations
→ DO NOT say "try a different search endpoint"
→ Conclude: needsMoreActions = false
→ Reason: "The requested item '[name]' was not found in the system after searching"
→ Set "item_not_found": true

────────────────────────────────────────
FORBIDDEN HEURISTICS
────────────────────────────────────────

❌ "The API call succeeded, so we're done"
❌ "There are no remaining steps"
❌ "The planner didn't include more actions"
❌ "The data exists, so the goal must be satisfied"
❌ "Keep searching with different variations" (when item clearly doesn't exist)

────────────────────────────────────────
CRITICAL: COUNT DERIVATION RULE
────────────────────────────────────────

If the goal asks for "count", "how many", "number of", etc.,
and an API endpoint returns a full list/array:

→ Counts MUST be derived by array.length
→ DO NOT request a dedicated count endpoint
→ DO NOT say "we need a count API"

────────────────────────────────────────
FINAL OVERRIDE RULE
────────────────────────────────────────

If you are unsure whether the user goal has been met,
you MUST respond with needsMoreActions = true.

False negatives are acceptable.
False positives are NOT.`;

    const userMessage = `Original Query: ${originalQuery}

Last Execution Plan: ${lastExecutionPlan ? JSON.stringify(lastExecutionPlan.execution_plan || lastExecutionPlan, null, 2) : 'No plan available'}

${lastExecutionPlan?.selected_tools_spec ? `
Available Tools (used in plan):
${JSON.stringify(lastExecutionPlan.selected_tools_spec, null, 2)}

These tools show what capabilities are available. If a tool returns an array,
counts can be derived via array.length. DO NOT request count endpoints.
` : ''}

Executed Steps (with responses): ${JSON.stringify(executedSteps, null, 2)}

Accumulated Results: ${JSON.stringify(accumulatedResults, null, 2)}

IMPORTANT:
1. Check if the last execution plan had multiple steps (e.g., fetching data for multiple IDs)
2. Verify if ALL required IDs/entities have been fetched
3. Review the "Available Tools" to see what derivations are possible (e.g., counts from array.length)
4. Only request more actions if there are genuinely missing IDs or the goal is incomplete
5. DO NOT request count/aggregation endpoints if arrays are already available

Can we answer the original query with the information we have? Or do we need more API calls?`;

    const result = await aiGenerateObject('gpt-4o', NeedMoreActionsSchema, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userMessage },
    ]);
    console.log('Validator Decision:', result);
    return {
      needsMoreActions: result.needsMoreActions,
      reason: result.reason,
      missing_requirements: result.missing_requirements ?? undefined,
      suggested_next_action: result.suggested_next_action ?? undefined,
      useful_data: result.useful_data ?? undefined,
      item_not_found: result.item_not_found ?? undefined,
    };
  } catch (error) {
    console.error('Error in validator:', error);
    return { needsMoreActions: false, reason: 'Validator error, proceeding with available data' };
  }
}
