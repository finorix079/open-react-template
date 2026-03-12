import { getAllMatchedApis, getTopKResults, fetchPromptFile } from '@/services/chatPlannerService';
import { aiGenerateObject, aiGenerateText, kimiChatCompletion } from '@/utils/aiHandler';
import { IntentSchema, ExecutionPlanSchema, PlannerValidationSchema } from '@/schemas/ai';
// import fs from 'fs';
// import path from 'path';

/**
 * sendToPlanner: 自主工作流程 - 始终使用 LLM 意图分析 + RAG API 检索 + 单步计划生成
 * @param refinedQuery - 用户精炼后的目标
 * @param apiKey - OpenAI Key
 * @param usefulData - 已有useful data（字符串）
 * @param conversationContext - 对话上下文
 * @returns plannerResponse（JSON字符串，单步执行计划）
 */
export async function sendToPlanner(
  refinedQuery: string,
  usefulData: string,
  conversationContext?: string,
  planIntentType?: 'FETCH' | 'MODIFY',
  forceFullPlan?: boolean
): Promise<string> {
  console.log('🚀 Planner autonomous workflow started');
  console.log('📌 Ignoring incoming apis parameter, using autonomous RAG retrieval');

  let retryCount = 0;
  const maxRetries = 3;
  let lastPlannerResponse = '';

  while (retryCount < maxRetries) {
    retryCount++;
    try {
      // ==================== STEP 1: LLM 分析下一步意图 ====================
      const contextInfo = conversationContext
        ? `\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\nCONVERSATION HISTORY (for context):\n${conversationContext}\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`
        : '';

        console.log('conversationContext: ', conversationContext);
        console.log('usefulData: ', usefulData);

      const validatorPrompt = `You are a [Goal Completion Validator].

Your sole responsibility:  
**Determine whether the goal has been completed based on the "User Goal" and "Existing Data".**

You do not care about the next steps or planning actions.
${contextInfo}
--------------------------------

User Goal:
${refinedQuery}

Existing Data (highest priority, actual API response):
${usefulData || 'None'}

--------------------------------

Judgment Rules (must strictly follow):

1. "Existing Data" is the only trustworthy source of facts
2. DELETE / INSERT / UPDATE actions themselves do not indicate completion
3. The goal is considered completed only in the following cases:
   - The most recent [read semantic] result shows the goal is achieved
   - Read semantics include:
     - GET
     - SELECT
     - post /general/sql/query (equivalent to GET)
4. If the last read semantic result clearly satisfies the user's goal → Goal completed
5. If there is no read semantic result that satisfies the goal → Goal not completed

--------------------------------

Output requirements (must strictly match):

- If the goal is completed, output only:
GOAL_COMPLETED

- If the goal is not completed, output only:
GOAL_NOT_COMPLETED

Do not output any explanations or extra text.

Begin judgment:`;

      console.log('📊 Step 0: Validating goal completion...');

      const validatorText = await aiGenerateText('gpt-4o', [
        { role: 'user', content: validatorPrompt },
      ]);
      console.log('✅ Goal completion validation response:', validatorText);

      if (validatorText === 'GOAL_COMPLETED') {
        console.log('🎯 Goal completed, returning result');
        return JSON.stringify({
          needs_clarification: false,
          execution_plan: [],
          message: 'Goal completed with existing data'
        });
      }

      // ==================== Intent 分析 Prompt ====================

      let nextIntent = refinedQuery;
      let intentType = planIntentType || 'FETCH';

      if (!planIntentType) {
        const nextActionPrompt = `You are the [Next Step Planner] for an API automation system.

Your premise:  
**The user's goal has NOT been completed.**
${contextInfo}
--------------------------------

User Goal:
${refinedQuery}

Existing Data (actual API response):
${usefulData || 'None'}

--------------------------------

Your task:

1. Always treat [completing the user's original goal] as the only endpoint
2. Analyze the existing data and determine what is still missing to reach the goal
3. Decide the [single most critical action] (do NOT plan multiple steps)
4. Describe this action in one sentence, including key entities and actions
5. Do NOT judge whether the goal is completed (this was already handled in the previous step)

--------------------------------

Output format (must strictly match):

{ 
  "description": "One-sentence description of the action intent", 
  "type": "FETCH" | "MODIFY" 
}

Do NOT output any explanations or extra text.
Begin planning:`;

        // ==================== STEP 1: LLM 分析下一步意图 ====================
        console.log('📊 Step 1: 分析下一步意图...');
        const intentRaw = await kimiChatCompletion({
          messages: [{ role: 'user', content: nextActionPrompt }],
          temperature: 0.3,
          max_tokens: 256,
        });
        console.log('✅ 意图分析响应:', intentRaw);
        // Extract JSON block and validate with Zod — no manual string repair
        const intentJsonMatch = intentRaw.match(/\{[\s\S]*\}/);
        const intentParsed = intentJsonMatch
          ? IntentSchema.safeParse(JSON.parse(intentJsonMatch[0]))
          : { success: false as const };
        if (!intentParsed.success) {
          console.error('Failed to parse intent JSON:', intentRaw);
          throw new Error('Invalid JSON format in intent analysis response.');
        }
        nextIntent = intentParsed.data.description.trim();
        intentType = intentParsed.data.type;
        console.log('✅ 下一步意图:', nextIntent);

        // 如果目标已完成
        if (nextIntent === 'GOAL_COMPLETED' || nextIntent.includes('GOAL_COMPLETED')) {
          return JSON.stringify({
            needs_clarification: false,
            execution_plan: [],
            message: 'Goal completed with existing data'
          });
        }
      } else {
        console.log(`📊 Intent provided by caller: type=${planIntentType}, intent="${nextIntent}"`);
      }

      // ==================== STEP 2: RAG 检索相关 API 和 Table ====================
      console.log('🔍 Step 2: RAG retrieving relevant APIs and Tables...');
      let ragApis: any[] = [];
      try {
        // For MODIFY intents: retrieve both tables and APIs
        // For FETCH intents: retrieve only tables
        if (intentType === 'MODIFY') {
          console.log('📊 MODIFY intent: retrieving both TABLE and API resources...');
          const allMatchedApis = await getAllMatchedApis({ entities: [nextIntent], intentType: 'MODIFY' });
          ragApis = await getTopKResults(allMatchedApis, 20);
          console.log(`✅ Retrieved ${ragApis.length} relevant resources (tables + APIs)`);
        } else {
          console.log('📊 FETCH intent: retrieving only TABLE resources...');
          const allMatchedApis = await getAllMatchedApis({ entities: [nextIntent], intentType: 'FETCH' });
          // Filter to only include table schemas (not REST APIs)
          const allResults = await getTopKResults(allMatchedApis, 20);
          ragApis = allResults.filter((item: any) => 
            item.id && typeof item.id === 'string' && (item.id.startsWith('table-') || item.id === 'sql-query')
          );
          console.log(`✅ Retrieved ${ragApis.length} relevant table schemas (tables only)`);
        }
      } catch (e) {
        console.warn('⚠️ RAG retrieval failed:', e);
        ragApis = [];
      }

      if (ragApis.length === 0) {
        console.warn('⚠️ No relevant resources found, unable to generate execution plan');
        const sorryMessage = `I'm sorry, but there are no relevant ${intentType === 'MODIFY' ? 'APIs, tables, or columns' : 'tables or columns'} in the database schema that can provide information about "${refinedQuery}". Therefore, I am unable to generate a ${intentType === 'MODIFY' ? 'plan or API call' : 'SQL query'} for this request.`;
        return JSON.stringify({
          impossible: true,
          needs_clarification: false,
          message: sorryMessage,
          reason: 'No relevant database resources found',
          execution_plan: []
        });
      }

      // fs.writeFileSync(path.join(process.cwd(), 'rag_apis.json'), JSON.stringify(ragApis, null, 2), 'utf-8');

      const ragApiDesc = JSON.stringify(ragApis, null, 2);

      // ==================== STEP 3: LLM 生成执行计划 ====================
      console.log('📝 Step 3: Generating Execution Plan...');

      const plannerSystemPrompt = await fetchPromptFile(intentType === 'FETCH' ? 'prompt-planner-table.txt' : 'prompt-planner.txt');

      const plannerUserMessage = intentType === 'MODIFY'
        ? `${contextInfo}User's Ultimate Goal: ${refinedQuery}

    You must produce the COMPLETE remaining execution plan (all steps) required to fulfill the goal, including any prerequisite data fetch/resolution steps followed by the modification step(s).

    Rules:
    - IMPORTANT: Consider the conversation history above to understand context and references (e.g., "it", "that item", "the pokemon")
    - Include every remaining step in order; do not stop after the first step.
    - Use TABLE/SQL (POST /general/sql/query) for any lookups/resolution before mutation; keep REST APIs for the actual mutations.
    - You have access to BOTH table schemas AND REST API specifications in the available resources below.
    - Zero placeholders: all parameters must be concrete or omitted.
    - Do not ask the user for info; rely on lookups instead.

    ${forceFullPlan ? '- PRIOR RESPONSE WAS RESOLUTION-ONLY. DO NOT STOP AT RESOLUTION. RETURN THE ENTIRE EXECUTION_PLAN WITH MODIFICATION STEPS INCLUDED.' : ''}

    Available Resources (Tables + APIs): ${ragApiDesc}

    Useful Data: ${usefulData || 'None'}

    Output the full execution_plan array covering resolution (SQL queries) + mutation (REST APIs) + validation (SQL queries) steps.`
        : `${contextInfo}User's Ultimate Goal: ${refinedQuery}

    CRITICAL: Your ONLY task is to execute THIS specific step:
    "${nextIntent}"

    DO NOT worry about the ultimate goal (${refinedQuery}) in this step.
    - IMPORTANT: Consider the conversation history above to understand context and references
    - This is a FETCH intent - generate a read-only plan using SQL queries
    - Use TABLE/SQL (POST /general/sql/query) for all data retrieval
    - You have access ONLY to table schemas (no REST APIs for FETCH)

    Focus ONLY on: ${nextIntent}

    Available Resources (Tables only): ${ragApiDesc}

    Useful Data: ${usefulData || 'None'}

    IMPORTANT: Execute ONLY the "Next Step Intent" above using SQL queries.`;

      console.log('Planner System Prompt:', plannerSystemPrompt);
      const plannerObj = await aiGenerateObject('gpt-4o', ExecutionPlanSchema, [
        { role: 'system', content: plannerSystemPrompt },
        { role: 'user', content: plannerUserMessage },
      ])
      .catch((e) => {
        console.error('Error generating execution plan:', e);
        throw new Error('Failed to generate execution plan');
      });
      let plannerResponse = JSON.stringify(plannerObj);
      console.log('✅ Original Planner Response:', plannerResponse);

      let retryNeeded = true;

      let validationAttempts = 0;
      while (retryNeeded && validationAttempts < 2) {
        validationAttempts++;
        // Let the LLM self-validate SQL and schema consistency
        const validationPrompt = `
You are a SQL/schema validator. 
Your job is to check if the SQL query references tables and columns that exist in the provided table schemas.

CRITICAL RULES:
1. The schemas may be in different formats (table metadata, DDL, or field lists in "content")
2. Look CAREFULLY at the "content" field of each schema entry - it often contains the full column definitions
3. Extract table names and column lists from patterns like "table_name(col1, col2, col3)"
4. Common columns like "id", "identifier", "user_id", "pokemon_id" are standard and likely valid
5. CURRENT_USER_ID is a special placeholder, NOT a schema issue - IGNORE IT
6. Only flag OBVIOUS missing tables or clearly wrong column names

Available Table Schemas:
${ragApiDesc}

Current Plan Response:
${plannerResponse}

VALIDATION APPROACH:
- Parse the "content" field carefully - it contains column definitions like "pokemon(id, identifier, ...)"
- If a table is referenced and appears in the schemas, assume standard columns (id, identifier, etc.) exist
- ONLY return needs_clarification: true if a TABLE is completely missing or a column is clearly wrong

Output:
{ "needs_clarification": false } if the query looks reasonable
{ "needs_clarification": true, "reason": "...", "clarification_question": "..." } ONLY for obvious errors`;
        let validationObj: { needs_clarification: boolean; reason?: string | null; clarification_question?: string | null };
        try {
          validationObj = await aiGenerateObject('gpt-4o', PlannerValidationSchema, [
            { role: 'user', content: validationPrompt },
          ]);
        } catch (e) {
          console.error('Failed to generate validation response:', e);
          break;
        }
        // 如果LLM发现有schema不符，直接clarify
        if (validationObj.needs_clarification === true) {
          console.warn('⚠️ SQL/schema不符，clarification:', validationObj.reason);
          plannerResponse = JSON.stringify(validationObj);
          retryNeeded = false;
        } else {
          // 校验通过，保留原始plannerResponse（包含execution_plan），不覆盖
          console.log('✅ SQL/schema validation passed, keeping original execution plan');
          retryNeeded = false;
        }
      }

      // ==================== 验证和修正 ====================
      let containsAssumption = /\bassume\b|\bassuming\b/i.test(plannerResponse);
      let needsIdClarification = false;
      let needsClarification = false;

      try {
        const parsed = JSON.parse(plannerResponse);
        needsClarification = parsed.needs_clarification === true;

        if (plannerResponse.includes('<') && plannerResponse.includes('>')) {
            containsAssumption = true;
        }

        if (needsClarification) {
          const reason = (parsed.reason || '').toLowerCase();
          const question = (parsed.clarification_question || '').toLowerCase();
          const shouldLookupKeywords = [
            'id', 'identifier', 'type id', 'category id', 'status id',
            'stat id', 'ability id', 'move id', 'enum', 'code',
            'look it up', 'look up', 'using an api', 'use an api',
            'does not provide', 'necessary id', 'required id', 'internal id'
          ];
          needsIdClarification = shouldLookupKeywords.some(keyword =>
            reason.includes(keyword) || question.includes(keyword)
          );
        }
      } catch (e) {
        console.error('Failed to parse planner response:', e);
        throw new Error('Invalid JSON in planner response');
      }

      // 如果需要重新生成（有assumption或需要ID clarification）
      if (containsAssumption || needsIdClarification) {
        const correctionMessage = `CRITICAL ERROR: You are asking the user for information that MUST be resolved via API.

You MUST NOT ask for clarification about IDs, identifiers, names, codes, or any information that can be looked up via the provided APIs.

MANDATORY RULES:
1. If you need to resolve a human-readable name to an ID, you MUST use the appropriate search/lookup API
2. If you need any category, type, status, or entity ID, you MUST use the appropriate lookup endpoint
3. If you need enum values or internal codes, you MUST use the appropriate API to retrieve them
4. ONLY ask for clarification if the user's INTENT is ambiguous, NOT if you need to look up data

The available APIs can resolve these lookups. CREATE AN EXECUTION PLAN with ONLY THE FIRST STEP (step_number: 1) that starts the lookup process.

If intent is MODIFY, return the full remaining execution_plan (all steps, ordered) with "needs_clarification": false.`;

        console.warn(`⚠️ 需要重新生成计划 (retry ${retryCount}/${maxRetries})`);

        const retryObj = await aiGenerateObject('gpt-4o', ExecutionPlanSchema, [
          { role: 'system', content: plannerSystemPrompt },
          { role: 'user', content: plannerUserMessage },
          { role: 'assistant', content: plannerResponse },
          { role: 'user', content: correctionMessage },
        ]);
        plannerResponse = JSON.stringify(retryObj);
        console.log('✅ 重试后的 Planner 响应:', plannerResponse);
      }

      // 最终返回
      console.log('🎯 Final Executionable Plan generated: ' + plannerResponse);
      lastPlannerResponse = plannerResponse;
      return plannerResponse;

    } catch (error) {
      console.error(`❌ Error in sendToPlanner (attempt ${retryCount}/${maxRetries}):`, error);
      if (retryCount >= maxRetries) {
        // 如果有最后一次的响应，返回它
        if (lastPlannerResponse) {
          console.warn('⚠️ 返回最后一次有效响应');
          return lastPlannerResponse;
        }
        throw error;
      }
      // 继续重试
    }
  }

  throw new Error('Failed to generate plan after maximum retries');
}
