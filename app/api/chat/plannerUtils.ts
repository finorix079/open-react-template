/**
 * plannerUtils.ts
 * Functions for building and sanitizing execution plans, including reference-task fast-path,
 * SQL generation, placeholder resolution, and JSON sanitization.
 */
import jaison from '@/utils/jaison';
import { RequestContext } from '@/services/chatPlannerService';
import { kimiChatCompletion, openaiChatCompletion } from '@/utils/aiHandler';
import { SavedTask } from '@/services/taskService';
import { sendToPlanner } from './planner';

/**
 * Prepares planner inputs, calls sendToPlanner (or SQL path), and returns a parsed actionable plan.
 */
export async function runPlannerWithInputs({
  topKResults,
  refinedQuery,
  apiKey,
  usefulData,
  conversationContext,
  finalDeliverable,
  intentType,
  entities,
  requestContext,
  referenceTask,
}: {
  topKResults: any[];
  refinedQuery: string;
  apiKey: string;
  usefulData: string;
  conversationContext?: string;
  finalDeliverable?: string;
  intentType: 'FETCH' | 'MODIFY';
  entities?: string[];
  requestContext?: RequestContext;
  referenceTask?: SavedTask;
}): Promise<{ actionablePlan: any; planResponse: string }> {
  const hasSqlCandidate = topKResults.some(
    (item: any) => item.id && typeof item.id === 'string' && (item.id.startsWith('table-') || item.id === 'sql-query')
  );
  const isSqlRetrieval = intentType === 'FETCH' && hasSqlCandidate;
  console.log(`🔀 Planner input routing: intentType=${intentType}, hasSqlCandidate=${hasSqlCandidate}, isSqlRetrieval=${isSqlRetrieval}`);

  // OPTIMIZATION: If a reference task exists, use its plan directly to reduce LLM calls
  if (
    referenceTask &&
    referenceTask.steps &&
    Array.isArray(referenceTask.steps) &&
    referenceTask.steps.length > 0
  ) {
    console.log(`\n✨ FAST PATH: Using reference task plan directly (${referenceTask.steps.length} steps)`);
    console.log(`🧭 Reference task: ${referenceTask.id} (${referenceTask.taskName}, type=${referenceTask.taskType})`);

    const executionPlan = referenceTask.steps.map((step: any) => {
      const contentMatch = step.stepContent?.match(/—\s*(\w+)\s+(.+?)$/);
      const method = contentMatch ? contentMatch[1].toLowerCase() : 'post';
      const path = contentMatch ? contentMatch[2].trim() : '/general/sql/query';

      return {
        step_number: step.stepOrder || 1,
        description: step.stepContent || `Step ${step.stepOrder}`,
        api: {
          path,
          method,
          parameters: {},
          requestBody: {},
        },
        stepType: step.stepType,
      };
    });

    const actionablePlan = {
      needs_clarification: false,
      phase: referenceTask.taskType === 1 ? 'resolution' : 'execution',
      final_deliverable: finalDeliverable || '',
      execution_plan: executionPlan,
      selected_tools_spec: [],
      _from_reference_task: true,
      _reference_task_id: referenceTask.id,
    };

    console.log(
      `📋 Converted reference task to execution plan:`,
      JSON.stringify(
        executionPlan.map(s => ({
          step: s.step_number,
          description: s.description,
          api: `${s.api.method.toUpperCase()} ${s.api.path}`,
          type: s.stepType === 1 ? 'FETCH' : 'MODIFY',
        })),
        null,
        2
      )
    );

    const planResponse = JSON.stringify(actionablePlan);
    console.log('🪄 Using refetched reference plan:', planResponse);
    return { actionablePlan, planResponse };
  }

  const referenceTaskContext = referenceTask
    ? `\n\nReference task (reuse if similar):\n${JSON.stringify(
        {
          id: referenceTask.id,
          taskName: referenceTask.taskName,
          taskType: referenceTask.taskType,
          steps: referenceTask.steps,
        },
        null,
        2
      )}\nIf this task fits, adapt its steps instead of creating a brand-new plan. If not a good fit, continue with normal planning.`
    : '';
  const mergedConversationContext = referenceTaskContext
    ? `${conversationContext || ''}${referenceTaskContext}`
    : conversationContext;
  if (referenceTask) {
    console.log(
      `🧭 Planner received reference task ${referenceTask.id} (${referenceTask.taskName}) for reuse consideration.`
    );
  }

  if (!isSqlRetrieval) {
    // API mode: call sendToPlanner
    let planResponse = await sendToPlanner(refinedQuery, usefulData, mergedConversationContext, intentType);

    let actionablePlan;
    try {
      let sanitizedPlanResponse = sanitizePlannerResponse(planResponse);
      // Patch: Remove user_id from /pokemon/watchlist POST plan
      let planObj;
      try {
        planObj = JSON.parse(sanitizedPlanResponse);
        if (planObj && planObj.execution_plan && Array.isArray(planObj.execution_plan)) {
          planObj.execution_plan = planObj.execution_plan.map((step: any) => {
            if (
              step.api &&
              typeof step.api.path === 'string' &&
              step.api.path.replace(/^\/api/, '') === '/pokemon/watchlist' &&
              step.api.method &&
              step.api.method.toLowerCase() === 'post'
            ) {
              if (step.api.requestBody && typeof step.api.requestBody === 'object') {
                const newBody = { ...step.api.requestBody };
                delete newBody.user_id;
                delete newBody.userId;
                step.api.requestBody = newBody;
              }
            }
            return step;
          });
        }
        if (planObj && planObj.selected_tools_spec && Array.isArray(planObj.selected_tools_spec)) {
          planObj.selected_tools_spec = planObj.selected_tools_spec.map((tool: any) => {
            if (
              tool.endpoint &&
              tool.endpoint.replace(/^POST \/api/, 'POST ') === 'POST /pokemon/watchlist'
            ) {
              if (Array.isArray(tool.derivations)) {
                tool.derivations = tool.derivations.filter(
                  (d: string) => !d.toLowerCase().includes('user_id')
                );
              }
            }
            return tool;
          });
        }
        sanitizedPlanResponse = JSON.stringify(planObj);
      } catch (e) {
        // fallback: do nothing
      }
      console.log('Sanitized Planner Response:', sanitizedPlanResponse);
      actionablePlan = JSON.parse(sanitizedPlanResponse);
      if (actionablePlan && finalDeliverable) {
        actionablePlan.final_deliverable = finalDeliverable;
      }

      if (actionablePlan) {
        delete actionablePlan._replanned;
        delete actionablePlan._replan_reason;
      }

      if (actionablePlan?.impossible) {
        console.log('🚫 Planner marked task as impossible with current database resources.');
        return { actionablePlan, planResponse };
      }
    } catch (error) {
      console.warn('Failed to parse planner response as JSON:', error);
      console.warn('Original Planner Response:', planResponse);
      throw new Error('Failed to parse planner response');
    }

    // If MODIFY intent returned only resolution phase, force a full-plan retry
    if (
      intentType === 'MODIFY' &&
      actionablePlan?.phase === 'resolution' &&
      Array.isArray(entities) &&
      entities.length > 0
    ) {
      console.log(
        '♻️ Plan is resolution-only for MODIFY intent; re-planning with forceFullPlan=true...'
      );
      const tablePlanResponse = await sendToPlanner(refinedQuery, usefulData, conversationContext, 'MODIFY', true);
      const sanitizedPlanResponse = sanitizePlannerResponse(tablePlanResponse);
      actionablePlan = JSON.parse(sanitizedPlanResponse);
      planResponse = tablePlanResponse;
      if (actionablePlan && finalDeliverable) {
        actionablePlan.final_deliverable = finalDeliverable;
      }
      console.log('✅ Replanned with MODIFY intent and forceFullPlan=true for full execution plan.');
    }
    return { actionablePlan, planResponse };
  } else {
    // SQL/table retrieval mode
    const userQuestion = conversationContext
      ? `Previous context:\n${conversationContext}\n\nCurrent query: ${refinedQuery}`
      : refinedQuery;

    const tableSelectionPrompt = `You are a database schema analyst. Given a list of available tables and a user question, identify which tables and columns are most relevant.

Available Tables:
${JSON.stringify(topKResults, null, 2)}

User Question: ${userQuestion}

IMPORTANT RULES:
- Return ONLY a JSON object with the following structure:
{
  "selected_tables": ["table_name_1", "table_id_1", ...],
  "focus_columns": {
    "table_name_1": ["column1", "column2", ...],
    "table_name_2": ["column1", "column2", ...]
  },
  "reasoning": "Brief explanation of why these tables and columns were selected"
}

Output:`;

    let tableSelectionText = await kimiChatCompletion({
      messages: [{ role: 'system', content: tableSelectionPrompt }],
      temperature: 0.3,
      max_tokens: 1024,
    });

    const jsonMatch = tableSelectionText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error('Failed to parse table selection response');
    }

    const tableSelection = JSON.parse(jsonMatch[0]);
    console.log('📋 Table Selection Result:', tableSelection);

    if (!tableSelection.selected_tables || tableSelection.selected_tables.length === 0) {
      throw new Error('No tables selected for SQL generation', {
        cause: tableSelection.reasoning || 'No reasoning provided',
      });
    }

    const shortlistedTables = topKResults.filter((table: any) =>
      tableSelection.selected_tables.some(
        (selectedId: string) =>
          table.id === selectedId ||
          table.id.includes(selectedId) ||
          selectedId.includes(table.id)
      )
    );

    console.log('📊 Shortlisted Tables:', shortlistedTables.map((t: any) => t.id));

    const sqlSchema = `Relevant Tables:\n${JSON.stringify(shortlistedTables, null, 2)}

Focus Columns: ${JSON.stringify(tableSelection.focus_columns, null, 2)}

Selection Reasoning: ${tableSelection.reasoning}

- If a user ID is needed, always use CURRENT_USER_ID as the value.`;

    const sqlPrompt = `You are an expert SQL generator for PostgreSQL. Using the relevant tables and focus columns provided, generate a valid SQL query that answers the user question.

${sqlSchema}

User Question: ${userQuestion}

CRITICAL SQL RULES FOR POSTGRESQL:
1. Column aliases defined in SELECT cannot be used in HAVING clause
2. Must repeat the aggregate expression in HAVING instead of using the alias
3. Use single quotes (') for string literals, never smart quotes
4. Ensure proper GROUP BY clauses include all non-aggregated columns

Example:
❌ WRONG: SELECT SUM(x) as total ... HAVING total > 10
✅ CORRECT: SELECT SUM(x) as total ... HAVING SUM(x) > 10

Generate ONLY the SQL query (no explanations):

SQL:`;

    let sqlText = await openaiChatCompletion({
      messages: [{ role: 'system', content: sqlPrompt }],
      temperature: 0.3,
      max_tokens: 512,
    });
    sqlText = sqlText?.trim() || '';

    const sqlMatch = sqlText.match(/select[\s\S]+?;/i);
    if (sqlMatch) sqlText = sqlMatch[0];

    sqlText = sqlText
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201C\u201D]/g, '"')
      .replace(/\\n/g, ' ')
      .replace(/\\t/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    // Fix alias references in HAVING clause
    const selectMatch = sqlText.match(/SELECT\s+(.*?)\s+FROM/i);
    if (selectMatch) {
      const selectClause = selectMatch[1];
      const aliasPattern = /(\S+\([^)]+\)|[\w.]+)\s+(?:AS\s+)?(\w+)/gi;
      let match;
      const aliases = new Map<string, string>();

      while ((match = aliasPattern.exec(selectClause)) !== null) {
        const expression = match[1].trim();
        const alias = match[2].trim();
        if (/^(SUM|COUNT|AVG|MAX|MIN|ARRAY_AGG)\(/i.test(expression)) {
          aliases.set(alias.toLowerCase(), expression);
        }
      }

      if (aliases.size > 0) {
        sqlText = sqlText.replace(
          /HAVING\s+(.+?)(?=\s+(?:ORDER|LIMIT|;|$))/gi,
          (havingClause: any) => {
            let modifiedHaving = havingClause;
            aliases.forEach((expression, alias) => {
              const aliasRegex = new RegExp(`\\b${alias}\\b(?=\\s*[=<>!])`, 'gi');
              modifiedHaving = modifiedHaving.replace(aliasRegex, expression);
            });
            return modifiedHaving;
          }
        );
      }
    }

    console.log('🔍 Generated SQL:', sqlText);

    const planObj = {
      needs_clarification: false,
      phase: 'execution',
      final_deliverable: finalDeliverable || '',
      execution_plan: [
        {
          step_number: 1,
          description: 'Execute SQL query to fulfill user request',
          api: {
            path: '/general/sql/query',
            method: 'post',
            requestBody: { query: sqlText },
          },
        },
      ],
      selected_tools_spec: [
        {
          endpoint: 'POST /general/sql/query',
          purpose: 'Execute SQL query',
          returns: 'SQL query result',
          derivations: [`query = ${JSON.stringify(sqlText)}`],
        },
      ],
    };
    const planResponse = JSON.stringify(planObj);
    return { actionablePlan: planObj, planResponse };
  }
}

/**
 * Sanitizes a raw planner response string into valid JSON using jaison.
 * Extracts the first JSON object/array found in the string.
 */
export function sanitizePlannerResponse(response: string): string {
  try {
    console.log('response to sanitize:', response);
    const firstMatch = response.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!firstMatch) {
      throw new Error('No JSON object or array found in the response.');
    }
    console.log('firstMatch:', firstMatch[0]);
    const cleaned = firstMatch[0];

    const jsonFixed = jaison(cleaned);
    console.log('jsonFixed:', jsonFixed);
    if (jsonFixed) {
      return JSON.stringify(jsonFixed);
    }

    throw new Error('No valid JSON found in the response.');
  } catch (error) {
    console.error('Error sanitizing planner response:', error);
    throw error;
  }
}

/**
 * Returns true if the object contains any "resolved_from_step_X" placeholder strings.
 */
export function containsPlaceholderReference(obj: any): boolean {
  const placeholderPattern = /resolved_from_step_\d+/i;

  const checkValue = (value: any): boolean => {
    if (typeof value === 'string') {
      return placeholderPattern.test(value);
    }
    if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value)) {
        return value.some(checkValue);
      }
      return Object.values(value).some(checkValue);
    }
    return false;
  };

  return checkValue(obj);
}

/**
 * Resolves "resolved_from_step_X" placeholders in a step by extracting the actual value
 * from the referenced executed step's response using an LLM call.
 */
export async function resolvePlaceholders(
  stepToExecute: any,
  executedSteps: any[],
  apiKey: string
): Promise<{ resolved: boolean; reason?: string }> {
  const placeholderPattern = /resolved_from_step_(\d+)/i;
  let foundPlaceholder = false;
  let placeholderStepNum: number | null = null;

  if (stepToExecute.api?.parameters) {
    for (const [key, value] of Object.entries(stepToExecute.api.parameters)) {
      if (typeof value === 'string') {
        const match = value.match(placeholderPattern);
        if (match) {
          foundPlaceholder = true;
          placeholderStepNum = parseInt(match[1]);
          console.log(`🔍 Detected placeholder in parameters.${key}: "${value}" (references step ${placeholderStepNum})`);
        }
      }
    }
  }

  if (stepToExecute.api?.requestBody) {
    const checkBody = (obj: any, path: string = ''): boolean => {
      for (const [key, value] of Object.entries(obj || {})) {
        const fullPath = path ? `${path}.${key}` : key;
        if (typeof value === 'string') {
          const match = value.match(placeholderPattern);
          if (match) {
            foundPlaceholder = true;
            placeholderStepNum = parseInt(match[1]);
            console.log(`🔍 Detected placeholder in requestBody.${fullPath}: "${value}" (references step ${placeholderStepNum})`);
            return true;
          }
        } else if (typeof value === 'object' && value !== null) {
          if (checkBody(value, fullPath)) return true;
        }
      }
      return false;
    };
    checkBody(stepToExecute.api.requestBody);
  }

  if (!foundPlaceholder || placeholderStepNum === null) {
    return { resolved: true };
  }

  const referencedStep = executedSteps.find(
    (s) =>
      s.step === placeholderStepNum ||
      s.stepNumber === placeholderStepNum ||
      s.step?.step_number === placeholderStepNum
  );

  if (!referencedStep) {
    const reason = `Referenced step ${placeholderStepNum} has not been executed yet`;
    console.error(`❌ ${reason}`);
    return { resolved: false, reason };
  }

  console.log(`\n📋 RESOLVING PLACEHOLDER: resolved_from_step_${placeholderStepNum}`);
  console.log(`   Referenced step response:`, JSON.stringify(referencedStep.response, null, 2));

  const apiKey_local = process.env.NEXT_PUBLIC_OPENAI_API_KEY;
  if (!apiKey_local) {
    return { resolved: false, reason: 'OpenAI API key not configured' };
  }

  try {
    const extractedValue = await openaiChatCompletion({
      messages: [
        {
          role: 'system',
          content: `You are a data extraction expert. Given a previous API response and the current step's requirements, extract the correct value to replace a "resolved_from_step_X" placeholder.

RULES:
1. Analyze the current step's API call to understand what value is needed
2. Look at the referenced step's response to find the matching data
3. Return ONLY the extracted value (no explanation, no JSON wrapping)
4. Common patterns:
   - If current step deletes by ID, extract the "id" field from previous step
   - If current step modifies a resource, extract the "id" that identifies that resource
   - If previous step returned multiple results, extract the first one's ID
5. If the data cannot be found, return "ERROR: [reason]"

Current Step Analysis:
- API Path: ${stepToExecute.api?.path}
- API Method: ${stepToExecute.api?.method}
- Parameters: ${JSON.stringify(stepToExecute.api?.parameters || {})}
- Request Body: ${JSON.stringify(stepToExecute.api?.requestBody || {})}

Previous Step (Step ${placeholderStepNum}) Response:
${JSON.stringify(referencedStep.response, null, 2)}

What value should replace "resolved_from_step_${placeholderStepNum}"? Return ONLY the value:`,
        },
      ],
      temperature: 0.2,
      max_tokens: 100,
    });

    console.log(`✅ LLM extracted value: "${extractedValue}"`);

    if (!extractedValue || extractedValue.startsWith('ERROR:')) {
      return { resolved: false, reason: `Failed to extract value: ${extractedValue}` };
    }

    if (stepToExecute.api?.parameters) {
      for (const [key, value] of Object.entries(stepToExecute.api.parameters)) {
        if (typeof value === 'string' && value.includes(`resolved_from_step_${placeholderStepNum}`)) {
          stepToExecute.api.parameters[key] = extractedValue;
          console.log(`   ✅ Replaced parameters.${key}: "${value}" → "${extractedValue}"`);
        }
      }
    }

    if (stepToExecute.api?.requestBody) {
      const replaceInBody = (obj: any): void => {
        for (const [key, value] of Object.entries(obj || {})) {
          if (
            typeof value === 'string' &&
            value.includes(`resolved_from_step_${placeholderStepNum}`)
          ) {
            obj[key] = obj[key].replace(
              `resolved_from_step_${placeholderStepNum}`,
              extractedValue
            );
            console.log(`   ✅ Replaced requestBody.${key}: "${value}" → "${extractedValue}"`);
          } else if (typeof value === 'object' && value !== null) {
            replaceInBody(value);
          }
        }
      };
      replaceInBody(stepToExecute.api.requestBody);
    }

    return { resolved: true };
  } catch (error: any) {
    console.error(`❌ Error resolving placeholder:`, error);
    return { resolved: false, reason: error.message };
  }
}
