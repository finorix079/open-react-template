/**
 * planner.ts
 * Autonomous planner workflow for PokéAPI queries.
 *
 * Uses a static PokéAPI tool catalog (via chatPlannerService → pokemonRagService)
 * instead of the old embedding-based retrieval against ElasticDash schemas.
 * All available tools are read-only PokéAPI endpoints.
 */
import { getAllMatchedApis, getTopKResults, fetchPromptFile } from '@/services/chatPlannerService';
import { openaiChatCompletion, kimiChatCompletion } from '@/utils/aiHandler';

/**
 * sendToPlanner: Autonomous planner workflow.
 * Step 0 — validate if goal is already satisfied by existing data.
 * Step 1 — infer next action intent.
 * Step 2 — retrieve relevant PokéAPI tools (keyword matching, no embedding calls).
 * Step 3 — generate execution plan using the LLM + tool context.
 */
export async function sendToPlanner(
  refinedQuery: string,
  usefulData: string,
  conversationContext?: string,
  planIntentType?: 'FETCH' | 'MODIFY',
  forceFullPlan?: boolean
): Promise<string> {
  console.log('🚀 Planner workflow started (PokéAPI mode)');

  let retryCount = 0;
  const maxRetries = 3;
  let lastPlannerResponse = '';

  while (retryCount < maxRetries) {
    retryCount++;
    try {
      // ==================== STEP 0: Check goal completion ====================
      const contextInfo = conversationContext
        ? `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nCONVERSATION HISTORY:\n${conversationContext}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`
        : '';

      const validatorPrompt = `You are a Goal Completion Validator for a Pokémon data assistant.

Determine whether the user's goal has already been satisfied by the existing data.
${contextInfo}
User Goal: ${refinedQuery}

Existing Data (from previous PokéAPI calls):
${usefulData || 'None'}

Rules:
1. "Existing Data" is the only trustworthy source of facts.
2. If the existing data clearly and fully answers the user goal → GOAL_COMPLETED
3. If the existing data is empty or does not fully answer → GOAL_NOT_COMPLETED

Output ONLY one of: GOAL_COMPLETED or GOAL_NOT_COMPLETED`;

      console.log('📊 Step 0: Validating goal completion...');
      const validatorText = await openaiChatCompletion({
        messages: [{ role: 'user', content: validatorPrompt }],
        temperature: 0.0,
        max_tokens: 32,
      });
      console.log('✅ Goal completion check:', validatorText);

      if (validatorText?.trim() === 'GOAL_COMPLETED') {
        return JSON.stringify({
          needs_clarification: false,
          execution_plan: [],
          message: 'Goal completed with existing data',
        });
      }

      // ==================== STEP 1: Infer next action intent ====================
      let nextIntent = refinedQuery;
      const intentType: 'FETCH' | 'MODIFY' = planIntentType || 'FETCH';

      if (!planIntentType) {
        const nextActionPrompt = `You are a query analyzer for a Pokémon data assistant.
${contextInfo}
User Goal: ${refinedQuery}

Existing Data: ${usefulData || 'None'}

Analyze the goal and describe the single next action needed to make progress.
Available data sources: Pokémon details, moves, abilities, berries (all from PokéAPI, read-only).

Output ONLY this JSON (no extra text):
{ "description": "One-sentence action description", "type": "FETCH" }`;

        console.log('📊 Step 1: Inferring next action...');
        let intentJson = await kimiChatCompletion({
          messages: [{ role: 'user', content: nextActionPrompt }],
          temperature: 0.3,
          max_tokens: 128,
        });

        try {
          const match = intentJson.match(/\{[\s\S]*\}/);
          if (match) intentJson = match[0];
          const intentObj = JSON.parse(intentJson);
          nextIntent = intentObj.description?.trim() || refinedQuery;
        } catch (e) {
          console.warn('Failed to parse intent JSON, using refinedQuery as intent:', e);
          nextIntent = refinedQuery;
        }
        console.log('✅ Next intent:', nextIntent);
      }

      // ==================== STEP 2: RAG — retrieve PokéAPI tools ====================
      console.log('🔍 Step 2: Retrieving PokéAPI tools via keyword matching...');
      let ragApis: any[] = [];
      try {
        const allMatchedApis = await getAllMatchedApis({
          entities: [nextIntent],
          intentType,
        });
        ragApis = await getTopKResults(allMatchedApis, 10);
        console.log(`✅ Retrieved ${ragApis.length} PokéAPI tools`);
      } catch (e) {
        console.warn('⚠️ Tool retrieval failed:', e);
        ragApis = [];
      }

      if (ragApis.length === 0) {
        return JSON.stringify({
          impossible: true,
          needs_clarification: false,
          message: `I can only look up Pokémon, moves, abilities, and berries from PokéAPI. I cannot answer "${refinedQuery}" with the available tools.`,
          reason: 'No relevant PokéAPI tools found',
          execution_plan: [],
        });
      }

      const ragApiDesc = JSON.stringify(ragApis, null, 2);

      // ==================== STEP 3: Generate execution plan ====================
      console.log('📝 Step 3: Generating execution plan...');

      const plannerSystemPrompt = await fetchPromptFile('prompt-planner.txt');

      const plannerUserMessage = `${contextInfo}User's Goal: ${refinedQuery}

CRITICAL: Your ONLY task is to execute THIS specific next step:
"${nextIntent}"

Available PokéAPI Tools:
${ragApiDesc}

Previously retrieved data:
${usefulData || 'None'}

${forceFullPlan ? 'IMPORTANT: Return the COMPLETE execution plan covering ALL remaining steps.' : ''}

Generate a concrete execution plan using ONLY the tools listed above.`;

      let plannerResponse = await openaiChatCompletion({
        messages: [
          { role: 'system', content: plannerSystemPrompt },
          { role: 'user', content: plannerUserMessage },
        ],
        temperature: 0.5,
        max_tokens: 1024,
      });

      plannerResponse = plannerResponse.replace(/```json|```/g, '').trim();
      const jsonMatch = plannerResponse.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('Invalid planner response format — no JSON found.');
      plannerResponse = jsonMatch[0];

      console.log('✅ Planner response:', plannerResponse);

      // Parse and validate
      const parsed = JSON.parse(plannerResponse);
      const needsClarification = parsed.needs_clarification === true;

      // If planner asks for info that should be resolved via a tool call, retry
      const containsAssumption = /\bassume\b|\bassuming\b/i.test(plannerResponse) ||
        (plannerResponse.includes('<') && plannerResponse.includes('>'));

      if (containsAssumption && !needsClarification) {
        const correctionMessage = `Your plan contains assumptions or placeholder values.
All parameters must be concrete values derived from the PokéAPI tool descriptions.
If you need a Pokémon name or ID, use it as-is from the user's query.
Do NOT assume or guess any values. Re-generate the plan with concrete values only.`;

        plannerResponse = await openaiChatCompletion({
          messages: [
            { role: 'system', content: plannerSystemPrompt },
            { role: 'user', content: plannerUserMessage },
            { role: 'assistant', content: plannerResponse },
            { role: 'user', content: correctionMessage },
          ],
          temperature: 0.5,
          max_tokens: 1024,
        });
        plannerResponse = plannerResponse.replace(/```json|```/g, '').trim();
        const retryMatch = plannerResponse.match(/\{[\s\S]*\}/);
        if (retryMatch) plannerResponse = retryMatch[0];
      }

      console.log('🎯 Final execution plan:', plannerResponse);
      lastPlannerResponse = plannerResponse;
      return plannerResponse;

    } catch (error) {
      console.error(`❌ Error in sendToPlanner (attempt ${retryCount}/${maxRetries}):`, error);
      if (retryCount >= maxRetries) {
        if (lastPlannerResponse) return lastPlannerResponse;
        throw error;
      }
    }
  }

  throw new Error('Failed to generate plan after maximum retries');
}
