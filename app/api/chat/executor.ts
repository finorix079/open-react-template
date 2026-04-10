/**
 * executor.ts
 * Functions for extracting useful data, generating final answers, and running the iterative
 * planner execution loop.
 */
import { NextResponse } from 'next/server';
import { FanOutRequest } from '@/services/apiService';
import { findApiParameters } from '@/services/apiSchemaLoader';
import { SavedTask } from '@/services/taskService';
import { getAllMatchedApis, getTopKResults, RequestContext } from '@/services/chatPlannerService';
import { kimiChatCompletion, openaiChatCompletion, agentTools } from '@/utils/aiHandler';
import type { LangfuseObservation } from '@langfuse/tracing';
import { sendToPlanner } from './planner';
import { sanitizePlannerResponse, containsPlaceholderReference, resolvePlaceholders } from './plannerUtils';
import { serializeUsefulDataInOrder } from './messageUtils';
import { validateNeedMoreActions } from './validators';
import { apiService } from '@/ed_tools';

/**
 * Derives the agentTools key and typed input from a plan step's API path and parameters,
 * mapping planner-generated parameter names to the exact names each tool function expects.
 *
 * Mapping rules:
 *   /pokemon/{name}  → fetchPokemonDetails  { id: string | number }
 *   /pokemon         → searchPokemon        { searchterm: string, page: number }
 *   /move/{name}     → searchMove           { searchterm: string, page: number }
 *   /move            → searchMove           { searchterm: string, page: number }
 *   /ability/{name}  → searchAbility        { searchterm: string, page: number }
 *   /ability         → searchAbility        { searchterm: string, page: number }
 *   /berry/{name}    → searchBerry          { query: string, page: number }
 *   /berry           → searchBerry          { query: string, page: number }
 *
 * Returns null for unrecognised paths.
 */
function resolvePokeApiTool(
  apiPath: string,
  parameters: Record<string, unknown>
): { toolName: string; input: Record<string, unknown> } | null {
  const cleanPath = (apiPath || '').replace(/\/$/, '');
  const segments = cleanPath.split('/').filter(Boolean);
  const resource = segments[0] || '';
  const nameOrId = segments[1];
  const page = Number((parameters as any)?.page ?? 0);

  if (resource === 'pokemon' && nameOrId) {
    const parsed = Number(nameOrId);
    return { toolName: 'fetchPokemonDetails', input: { id: isNaN(parsed) ? nameOrId : parsed } };
  }
  if (resource === 'pokemon') {
    // Planner may pass `name` or `searchterm`; tool expects `searchterm`
    const searchterm = String((parameters as any)?.searchterm ?? (parameters as any)?.name ?? '');
    return { toolName: 'searchPokemon', input: { searchterm, page } };
  }
  if (resource === 'move') {
    const searchterm = nameOrId || String((parameters as any)?.searchterm ?? (parameters as any)?.name ?? '');
    return { toolName: 'searchMove', input: { searchterm, page } };
  }
  if (resource === 'ability') {
    const searchterm = nameOrId || String((parameters as any)?.searchterm ?? (parameters as any)?.name ?? '');
    return { toolName: 'searchAbility', input: { searchterm, page } };
  }
  if (resource === 'berry') {
    // searchBerryTool uses `query` (not `searchterm` or `name`)
    const query = nameOrId || String((parameters as any)?.query ?? (parameters as any)?.name ?? '');
    return { toolName: 'searchBerry', input: { query, page } };
  }
  return null;
}

/**
 * Extracts and merges useful data from a single API response into the running useful-data string.
 * Uses Kimi for lightweight extraction.
 */
export async function extractUsefulDataFromApiResponses(
  refinedQuery: string,
  finalDeliverable: string,
  existingUsefulData: string,
  apiResponse: string,
  apiSchema?: any,
  availableApis?: any[]
): Promise<string> {
  try {
    let schemaContext = '';
    if (apiSchema) {
      schemaContext = `\n\nAPI Schema Context (endpoint that was just called):
Path: ${apiSchema.path}
Method: ${apiSchema.method}
Request Body: ${JSON.stringify(apiSchema.requestBody || {}, null, 2)}
Parameters: ${JSON.stringify(apiSchema.parameters || {}, null, 2)}`;
    }

    let availableApisContext = '';
    if (availableApis && availableApis.length > 0) {
      const apiSummaries = availableApis
        .slice(0, 10)
        .map((api: any) => {
          try {
            const content =
              typeof api.content === 'string' ? api.content : JSON.stringify(api.content);
            return `- ${api.id}: ${api.summary || 'No summary'}\n  ${content.slice(0, 200)}...`;
          } catch {
            return `- ${api.id}: ${api.summary || 'No summary'}`;
          }
        })
        .join('\n');

      availableApisContext = `\n\nAvailable APIs (for understanding data dependencies):
${apiSummaries}

CRITICAL: Check if any downstream APIs might need fields from the current response.
For example, if a "delete watchlist" API requires "pokemon_id", then pokemon_id must be preserved from the "get watchlist" response.`;
    }

    const prompt = `You are an expert at extracting useful information from API responses to help answer user queries.

Given the original user query, the refined query, and the final deliverable generated so far,
extract any useful data points, facts, or details from the API responses that could aid in answering the user's question.

CRITICAL RULES:
1. If the new API response contains UPDATED or MORE ACCURATE information, REPLACE the old data
2. Only keep UNIQUE and NON-REDUNDANT information
3. Remove any duplicate or outdated facts
4. Keep the output CONCISE but COMPLETE - include ALL fields that might be needed for downstream operations
5. If it contains things like ID, deleted, or other important data, make sure to include those

FIELD PRESERVATION RULES (CRITICAL):
- ALWAYS preserve ALL ID fields (id, pokemon_id, user_id, team_id, etc.) - these are often required for subsequent API calls
- ALWAYS preserve foreign key relationships (e.g., if an item has both "id" and "pokemon_id", keep BOTH)
- ALWAYS preserve status fields (deleted, active, success, etc.)
- ALWAYS preserve timestamps (created_at, updated_at, etc.) if they might be relevant
- When in doubt, KEEP the field rather than removing it
- Check the available APIs context to see if any downstream operations might need specific fields

FACTUAL REPORTING ONLY:
- Report ONLY what the API response explicitly states (e.g., "3 items were deleted", "ID 123 was created")
- DO NOT infer or state goal completion (e.g., NEVER say "watchlist has been cleared", "task completed", "goal achieved")
- DO NOT interpret the action's success in terms of user goals
- State facts like: "deletedCount: 3", "success: true", "ID: 456", "pokemon_id: 789"
- Let the validator and final answer generator determine if the goal is met

FORMAT:
Structure the extracted data to preserve relationships. For list responses, maintain the structure:
- If response contains an array of objects, preserve key fields from each object
- For single objects, preserve all important fields
- Use clear labels to indicate what each piece of data represents

If no new useful data is found, return the existing useful data as is.

Refined User Query: ${refinedQuery}
Final Deliverable: ${finalDeliverable}
Existing Useful Data: ${existingUsefulData}
API Response: ${apiResponse}${schemaContext}${availableApisContext}

Extracted Useful Data: `;

    const extractedData = await kimiChatCompletion({
      messages: [{ role: 'system', content: prompt }],
      temperature: 0.5,
      max_tokens: 4096,
    });
    return extractedData;
  } catch (error) {
    console.error('Error extracting useful data:', error);
    return existingUsefulData;
  }
}

/**
 * Generates a final natural-language answer from accumulated API results.
 * Handles special stop reasons (max_iterations, stuck_state, item_not_found).
 */
export async function generateFinalAnswer(
  originalQuery: string,
  accumulatedResults: any[],
  apiKey: string,
  stoppedReason?: string,
  usefulData?: string
): Promise<string> {
  try {
    const systemPrompt = `You are a helpful assistant that synthesizes information from API responses to answer user questions.
Provide a clear, concise, and well-formatted answer based on the accumulated data.
Use the actual data from the API responses to provide specific, accurate information.`;

    let additionalContext = '';

    if (stoppedReason === 'max_iterations') {
      return `Sorry, I was unable to gather enough information to provide a complete answer within the allowed steps.`;
    } else if (stoppedReason === 'stuck_state') {
      return `It seems that the information you're looking for may not be available through the current APIs. If you have more specific details or another question, feel free to ask!`;
    } else if (stoppedReason === 'item_not_found') {
      let searchedItem = '';
      try {
        for (const result of accumulatedResults) {
          if (
            result.response &&
            ((Array.isArray(result.response) && result.response.length === 0) ||
              result.response.result === null ||
              result.response.results?.length === 0 ||
              result.response.message?.toLowerCase().includes('not found'))
          ) {
            const step = result.step || result.description || '';
            searchedItem = step.toString();
            break;
          }
        }
      } catch (e) {
        console.warn('Could not extract searched item:', e);
      }
      return `I couldn't find the item you're looking for${searchedItem ? ` (${searchedItem})` : ''} in the system. The search returned no results. Please check the spelling or try a different search term.`;
    }

    const message = await openaiChatCompletion({
      messages: [
        {
          role: 'system',
          content: systemPrompt + additionalContext,
        },
        {
          role: 'user',
          content: `Original Question: ${originalQuery}

API Response Data:
${JSON.stringify(
  accumulatedResults,
  (key, value) => {
    if (Array.isArray(value) && value.length > 0) {
      return value;
    }
    return value;
  },
  2
) + (usefulData || '')}

IMPORTANT: The data above includes complete arrays. Pay careful attention to:
- Learning methods for moves (level-up, tutor, machine, egg, etc.)
- Type information for moves
- Power values for moves
- Any other detailed attributes

Only state facts that are explicitly present in the data. Do not make assumptions about learning methods or other attributes.`,
        },
      ],
      temperature: 0.7,
      max_tokens: 2048,
    });

    return message || 'Unable to generate answer.';
  } catch (error) {
    console.error('Error generating final answer:', error);
    return 'Error generating answer from the gathered information.';
  }
}

/**
 * Runs the iterative plan execution loop: executes each step, validates goal completion,
 * and re-plans if needed. Returns the final answer and execution trace.
 */
export async function executeIterativePlanner(
  refinedQuery: string,
  matchedApis: any[],
  initialPlanResponse: string,
  apiKey: string,
  userToken: string,
  finalDeliverable: string,
  usefulData: Map<string, any>,
  conversationContext: string,
  entities: any[] = [],
  requestContext: RequestContext,
  maxIterations: number = 50,
  referenceTask?: SavedTask | null,
  onToolCall?: (info: unknown) => void,
  parentSpan?: LangfuseObservation
): Promise<any> {
  let currentPlanResponse = initialPlanResponse;
  let accumulatedResults: any[] = [];
  let executedSteps: any[] = [];
  let iteration = 0;
  let planIteration = 0;
  let intentType: 'FETCH' | 'MODIFY' = matchedApis[0]?.id.startsWith('semantic') ? 'FETCH' : 'MODIFY';
  let stuckCount = 0;
  let stoppedReason = '';

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
      )}\nPrefer adapting this task's steps if it aligns with the current goal.`
    : '';
  const conversationContextWithReference = referenceTaskContext
    ? `${conversationContext}${referenceTaskContext}`
    : conversationContext;

  if (referenceTask) {
    console.log(`🧭 Iterative executor using reference task ${referenceTask.id} (${referenceTask.taskName}) for replanning context.`);
  } else {
    console.log('🧭 Iterative executor running without reference task.');
  }

  console.log('\n' + '='.repeat(80));
  console.log('🔄 STARTING ITERATIVE PLANNER');
  console.log(`Max API calls allowed: ${maxIterations}`);
  console.log('='.repeat(80));

  let sanitizedPlanResponse = currentPlanResponse;
  console.log('sanitizedPlanResponse: ', sanitizedPlanResponse);
  let actionablePlan = JSON.parse(sanitizedPlanResponse);

  // Helper: Sanitize response for JSON serialization (remove circular references)
  function sanitizeForSerialization(obj: any): any {
    const seen = new WeakSet();
    return JSON.parse(
      JSON.stringify(obj, (key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
          if (key === 'request' || key === 'socket' || key === 'agent' || key === 'res') return '[Omitted]';
          if (key === 'config') return { method: value.method, url: value.url, data: value.data };
          if (key === 'headers' && value.constructor?.name === 'AxiosHeaders') {
            return Object.fromEntries(Object.entries(value));
          }
        }
        return value;
      })
    );
  }

  // Helper: Generate a stable unique key for an API call
  function getApiCallKey(path: string, method: string, params: any, body: any): string {
    const stableStringify: (obj: any) => string = (obj: any) => {
      if (!obj || typeof obj !== 'object') return String(obj);
      if (Array.isArray(obj)) return '[' + obj.map(stableStringify).join(',') + ']';
      return (
        '{' +
        Object.keys(obj)
          .sort()
          .map(k => JSON.stringify(k) + ':' + stableStringify(obj[k]))
          .join(',') +
        '}'
      );
    };
    const combinedInput = {
      ...(params && typeof params === 'object' ? params : {}),
      ...(body && typeof body === 'object' ? { _body: body } : {}),
    };
    return `${method.toLowerCase()} ${path}::${stableStringify(combinedInput)}`;
  }

  // Circular-reference-safe sanitizer for validation inputs
  function sanitizeForValidation(obj: any): any {
    const seen = new WeakSet();
    return JSON.parse(
      JSON.stringify(obj, (key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
          if (key === 'request' || key === 'socket' || key === 'agent' || key === 'res') return '[Omitted]';
          if (key === 'config') return { method: value.method, url: value.url, data: value.data };
          if (key === 'headers' && value.constructor?.name === 'AxiosHeaders') {
            return Object.fromEntries(Object.entries(value));
          }
        }
        return value;
      })
    );
  }

  while (planIteration < 20) {
    planIteration++;
    console.log(`\n--- Planning Cycle ${planIteration} (API calls made: ${iteration}/${maxIterations}) ---`);

    try {
      console.log('Current Actionable Plan:', JSON.stringify(actionablePlan, null, 2));

      if (actionablePlan.needs_clarification) {
        console.warn('Planner requires clarification:', actionablePlan.reason);
        return {
          error: 'Clarification needed',
          clarification_question: actionablePlan.clarification_question,
          reason: actionablePlan.reason,
        };
      }

      if (!actionablePlan.execution_plan || actionablePlan.execution_plan.length === 0) {
        console.log('No more steps in execution plan');
        break;
      }

      const progressBeforeExecution = accumulatedResults.length;

      console.log(`\n📋 Executing complete plan with ${actionablePlan.execution_plan.length} steps`);
      console.log(
        `📌 Execution mode: ${intentType === 'MODIFY' ? 'MODIFY (execute all, validate once at end)' : 'FETCH (execute and validate)'}`
      );

      let hasApiError = false;

      while (actionablePlan.execution_plan?.length > 0) {
        const step = actionablePlan.execution_plan.shift();
        console.log(`\nExecuting step ${step.step_number || executedSteps.length + 1}:`, JSON.stringify(step, null, 2));

        // Reference-task MODIFY step detection
        if (actionablePlan._from_reference_task && referenceTask) {
          const isModifyStep = step.stepType === 2;
          const stepMethod = step.api?.method?.toLowerCase();
          const isModifyByMethod = ['post', 'put', 'patch', 'delete'].includes(stepMethod);

          if (isModifyStep || isModifyByMethod) {
            console.log(`\n⏸️  MODIFY step detected in reference task flow. Pausing for user approval.`);
            return {
              message: `Reference task execution paused before MODIFY action. Review the gathered data and approve to proceed.`,
              reason: 'modify_step_reached',
              executedSteps,
              accumulatedResults,
              remainingPlan: {
                steps: [step, ...actionablePlan.execution_plan],
                description: 'Remaining steps to execute after user approval',
              },
              iterations: iteration,
            };
          }
        }

        if (step.api && step.api.path && step.api.method) {
          let stepsToExecute = [step];

          if ((step.depends_on_step || step.dependsOnStep) && accumulatedResults.length > 0) {
            const dependsOnStepNum = step.depends_on_step || step.dependsOnStep;
            const previousStepResult = accumulatedResults.find(r => r.step === dependsOnStepNum);

            if (previousStepResult && previousStepResult.response) {
              const results =
                previousStepResult.response.result?.results || previousStepResult.response.results;

              if (Array.isArray(results) && results.length > 1) {
                const pathParamMatches = step.api.path.match(/\{(\w+)\}/g);
                if (pathParamMatches && pathParamMatches.length > 0) {
                  console.log(
                    `\n🔄 Step ${step.step_number} will be executed ${results.length} times (once for each result from step ${dependsOnStepNum})`
                  );
                  stepsToExecute = results.map((result: any, index: number) => {
                    const clonedStep = JSON.parse(JSON.stringify(step));
                    clonedStep._executionIndex = index;
                    clonedStep._sourceData = result;
                    return clonedStep;
                  });
                }
              }
            }
          }

          for (const stepToExecute of stepsToExecute) {
            if (iteration >= maxIterations) {
              console.warn(`⚠️ Reached max iterations (${maxIterations}) during step execution`);
              return {
                error: 'Max iterations reached',
                message: `Sorry, I was unable to complete the task within the allowed ${maxIterations} API calls.`,
                executedSteps,
                accumulatedResults,
                iterations: iteration,
              };
            }

            iteration++;
            console.log(`\n📌 Executing API call #${iteration}/${maxIterations} (step ${stepToExecute.step_number})...`);

            let requestBodyToUse = stepToExecute.api.requestBody;
            let parametersToUse = stepToExecute.api.parameters || stepToExecute.input || {};

            if ((stepToExecute.depends_on_step || stepToExecute.dependsOnStep) && accumulatedResults.length > 0) {
              const dependsOnStepNum = stepToExecute.depends_on_step || stepToExecute.dependsOnStep;
              const previousStepResult = accumulatedResults.find(r => r.step === dependsOnStepNum);

              if (previousStepResult && previousStepResult.response) {
                console.log(`Step ${stepToExecute.step_number} depends on step ${dependsOnStepNum} - populating data from previous results`);
                requestBodyToUse = JSON.parse(JSON.stringify(stepToExecute.api.requestBody));

                let results;
                if (stepToExecute._sourceData) {
                  results = [stepToExecute._sourceData];
                } else if (
                  previousStepResult.response.result?.results ||
                  previousStepResult.response.results
                ) {
                  results =
                    previousStepResult.response.result?.results || previousStepResult.response.results;
                }

                if (results && Array.isArray(results)) {
                  if (Array.isArray(results) && results.length > 0) {
                    const populateEmptyArrays = (obj: any, path: string = '') => {
                      for (const key in obj) {
                        const fullPath = path ? `${path}.${key}` : key;
                        if (Array.isArray(obj[key]) && obj[key].length === 0) {
                          let numIds = 1;
                          if (key.toLowerCase().includes('pokemon') && key.toLowerCase().includes('id')) {
                            numIds = 3;
                          }
                          let extractedIds: any[];
                          if (key.toLowerCase().includes('type')) {
                            extractedIds = results
                              .slice(0, numIds)
                              .map((item: any) => item.type_id || item.id);
                          } else {
                            extractedIds = results
                              .slice(0, numIds)
                              .map((item: any) => item.id || item.pokemon_id);
                          }
                          obj[key] = extractedIds;
                          console.log(`Populated ${fullPath} with: ${JSON.stringify(extractedIds)}`);
                        } else if (
                          typeof obj[key] === 'object' &&
                          obj[key] !== null &&
                          !Array.isArray(obj[key])
                        ) {
                          populateEmptyArrays(obj[key], fullPath);
                        }
                      }
                    };

                    const populateSingleIds = (obj: any, path: string = '') => {
                      for (const key in obj) {
                        const fullPath = path ? `${path}.${key}` : key;
                        if (obj[key] === null && key.toLowerCase().includes('id')) {
                          obj[key] = results[0]?.id || results[0]?.pokemon_id;
                          console.log(`Populated ${fullPath} with single ID: ${obj[key]}`);
                        } else if (
                          typeof obj[key] === 'object' &&
                          obj[key] !== null &&
                          !Array.isArray(obj[key])
                        ) {
                          populateSingleIds(obj[key], fullPath);
                        }
                      }
                    };

                    populateEmptyArrays(requestBodyToUse);
                    populateSingleIds(requestBodyToUse);

                    const apiPath = stepToExecute.api.path;
                    const pathParamMatches = apiPath.match(/\{(\w+)\}/g);
                    if (pathParamMatches && pathParamMatches.length > 0) {
                      parametersToUse = { ...(stepToExecute.api.parameters || stepToExecute.input || {}) };
                      pathParamMatches.forEach((placeholder: string) => {
                        const paramName = placeholder.replace(/[{}]/g, '');
                        if (!parametersToUse[paramName] || parametersToUse[paramName] === '') {
                          const extractedId =
                            results[0]?.id || results[0]?.pokemon_id || results[0]?.teamId;
                          if (extractedId) {
                            parametersToUse[paramName] = extractedId;
                            console.log(`✅ Auto-populated path parameter {${paramName}} with value: ${extractedId}`);
                          } else {
                            console.warn(`⚠️  Could not extract ID for path parameter {${paramName}} from previous step results`);
                          }
                        }
                      });
                    }
                  }
                }
              }
            }

            // Resolve placeholders before executing
            console.log(`\n🔎 Checking for placeholder references in step ${stepToExecute.step_number || executedSteps.length + 1}...`);
            const stepToCheck = {
              api: {
                path: stepToExecute.api.path,
                method: stepToExecute.api.method,
                parameters: parametersToUse,
                requestBody: requestBodyToUse,
              },
            };

            if (containsPlaceholderReference(stepToCheck)) {
              console.log(`⚠️  Step contains placeholder reference(s), attempting resolution...`);
              const resolutionResult = await resolvePlaceholders(stepToCheck, executedSteps, apiKey);

              if (!resolutionResult.resolved) {
                console.error(`❌ CRITICAL: Failed to resolve placeholder - ${resolutionResult.reason}`);
                return NextResponse.json(
                  {
                    error: 'Placeholder resolution failed',
                    reason: resolutionResult.reason,
                    stepNumber: stepToExecute.step_number || executedSteps.length + 1,
                    step: stepToCheck,
                    executedSteps,
                    accumulatedResults,
                    message: `Cannot proceed: ${resolutionResult.reason}. Please review the plan and ensure all referenced steps have been executed.`,
                  },
                  { status: 400 }
                );
              }

              parametersToUse = stepToCheck.api.parameters;
              requestBodyToUse = stepToCheck.api.requestBody;
              console.log(`✅ Placeholders resolved successfully`);
            } else {
              console.log(`✅ No placeholder references detected`);
            }

            const parametersSchema = findApiParameters(stepToExecute.api.path, stepToExecute.api.method);
            let apiSchema = {
              ...stepToExecute.api,
              requestBody: requestBodyToUse,
              parameters: parametersToUse,
              parametersSchema,
            };

            let apiResponse;
            try {
              // Route through the named agentTool so Langfuse records each PokéAPI call
              // as a child tool observation under the parent span.
              const resolved = resolvePokeApiTool(stepToExecute.api.path, parametersToUse);
              if (parentSpan && resolved && agentTools[resolved.toolName]) {
                console.log(`📡 Calling agentTool "${resolved.toolName}" with Langfuse tracing`);
                apiResponse = await agentTools[resolved.toolName].execute(resolved.input, parentSpan);
              } else {
                apiResponse = await apiService({
                  baseUrl: process.env.NEXT_PUBLIC_POKEAPI_BASE_URL || 'https://pokeapi.co/api/v2',
                  schema: apiSchema,
                  userToken
                });
              }
            } catch (err: any) {
              console.warn(`⚠️  API call encountered an error (statusCode: ${err.statusCode}):`, err.message);

              if (
                intentType === 'MODIFY' &&
                err.statusCode &&
                [400, 403, 404, 409, 422, 500].includes(err.statusCode)
              ) {
                console.error(`❌ MODIFY flow encountered critical error (${err.statusCode}): ${err.message}`);
                hasApiError = true;
                actionablePlan.execution_plan = [];

                apiResponse = {
                  success: false,
                  error: true,
                  statusCode: err.statusCode,
                  message: err.message || 'API request failed',
                  details: err.response || err.data || null,
                  _originalError: { name: err.name, message: err.message },
                };

                const sanitizedResponse = sanitizeForSerialization(apiResponse);
                executedSteps.push({
                  step: stepToExecute,
                  response: sanitizedResponse,
                  stepNumber: stepToExecute.step_number || executedSteps.length,
                  error: true,
                  errorMessage: err.message,
                });
                accumulatedResults.push({
                  step: stepToExecute.step_number || executedSteps.length,
                  description: stepToExecute.description || 'API call',
                  response: sanitizedResponse,
                  error: true,
                  errorMessage: err.message,
                });
                console.log(`📤 Error recorded. Exiting execution loop to re-plan.`);
                break;
              }

              if (typeof err?.message === 'string' && err.message.includes('参数类型不匹配')) {
                console.warn('参数类型不匹配，打回AI重写:', err.message);
                return {
                  error: '参数类型不匹配',
                  reason: err.message,
                  executedSteps,
                  accumulatedResults,
                  clarification_question: `参数类型不匹配：${err.message}。请根据API schema重写参数。`,
                };
              }

              apiResponse = {
                success: false,
                error: true,
                statusCode: err.statusCode || err.status || 500,
                message: err.message || 'API request failed',
                details: err.response || err.data || null,
                _originalError: { name: err.name, message: err.message, stack: err.stack },
              };
              console.log(`📋 Treating error as response data:`, apiResponse);
            }

            // Fan-out support
            if (apiResponse && typeof apiResponse === 'object' && 'needsFanOut' in apiResponse) {
              const fanOutReq = apiResponse as FanOutRequest;
              console.log(`\n🔄 需要 fan-out: ${fanOutReq.fanOutParam} = [${fanOutReq.fanOutValues.join(', ')}]`);

              const fanOutResults: any[] = [];
              for (const value of fanOutReq.fanOutValues) {
                const singleValueSchema = {
                  ...fanOutReq.baseSchema,
                  parameters: { ...fanOutReq.mappedParams, [fanOutReq.fanOutParam]: value },
                  parametersSchema,
                };

                console.log(`  📤 Fan-out 调用 ${fanOutReq.fanOutParam}=${value}`);
                let singleResult;
                try {
                  singleResult = await apiService({
                    baseUrl: process.env.NEXT_PUBLIC_POKEAPI_BASE_URL || 'https://pokeapi.co/api/v2',
                    schema: singleValueSchema,
                    userToken
                  });
                } catch (err: any) {
                  if (typeof err?.message === 'string' && err.message.includes('参数类型不匹配')) {
                    console.warn('参数类型不匹配，打回AI重写:', err.message);
                    return {
                      error: '参数类型不匹配',
                      reason: err.message,
                      executedSteps,
                      accumulatedResults,
                      clarification_question: `参数类型不匹配：${err.message}。请根据API schema重写参数。`,
                    };
                  }
                  console.warn(`⚠️  Fan-out call for ${fanOutReq.fanOutParam}=${value} encountered an error:`, err.message);
                  singleResult = {
                    success: false,
                    error: true,
                    statusCode: err.statusCode || err.status || 500,
                    message: err.message || 'API request failed',
                  };
                }
                fanOutResults.push({ [fanOutReq.fanOutParam]: value, result: singleResult });
              }

              console.log(`✅ Fan-out 完成，共 ${fanOutResults.length} 个结果`);
              const mergedResponse = {
                fanOutResults,
                summary: `Retrieved data for ${fanOutResults.length} ${fanOutReq.fanOutParam}(s)`,
              };
              Object.assign(apiResponse, mergedResponse);
            }

            console.log('(executor) API Response:', apiResponse);

            const flatUsefulDataMap: Map<string, any> = requestContext.flatUsefulDataMap;
            const usefulDataArray = requestContext.usefulDataArray;

            const apiCallKey = getApiCallKey(apiSchema.path, apiSchema.method, parametersToUse, requestBodyToUse);
            const prevUsefulData = flatUsefulDataMap.get(apiCallKey) || '';
            const isNewEntry = !flatUsefulDataMap.has(apiCallKey);

            const sanitizedResponse = sanitizeForSerialization(apiResponse);

            const newUsefulData = await extractUsefulDataFromApiResponses(
              refinedQuery,
              finalDeliverable,
              prevUsefulData,
              JSON.stringify(sanitizedResponse),
              apiSchema,
              matchedApis
            );

            flatUsefulDataMap.set(apiCallKey, newUsefulData);

            if (isNewEntry) {
              usefulDataArray.push({ key: apiCallKey, data: newUsefulData, timestamp: Date.now() });
            } else {
              const existingIndex = usefulDataArray.findIndex(item => item.key === apiCallKey);
              if (existingIndex !== -1) {
                usefulDataArray[existingIndex].data = newUsefulData;
                usefulDataArray[existingIndex].timestamp = Date.now();
              }
            }

            usefulData = flatUsefulDataMap;

            let processedResponse = apiResponse;
            try {
              if (typeof apiResponse === 'string') {
                processedResponse = JSON.parse(apiResponse);
              }
              if (processedResponse && typeof processedResponse === 'object') {
                processedResponse = sanitizeForSerialization(processedResponse);
              }
            } catch (e) {
              console.warn('Could not process API response:', e);
            }

            const sanitizedProcessedResponse = sanitizeForSerialization(processedResponse);

            executedSteps.push({
              stepNumber: stepToExecute.step_number || executedSteps.length + 1,
              step: stepToExecute,
              response: sanitizedProcessedResponse,
            });

            accumulatedResults.push({
              step: stepToExecute.step_number || executedSteps.length,
              description: stepToExecute.description || 'API call',
              response: sanitizedProcessedResponse,
              executionIndex: stepToExecute._executionIndex,
            });

            onToolCall?.({
              stepNumber: stepToExecute.step_number || executedSteps.length,
              description: stepToExecute.description || 'API call',
              path: stepToExecute.api?.path,
              method: stepToExecute.api?.method,
            });

            console.log(
              `✅ Step ${stepToExecute.step_number || executedSteps.length} completed. Remaining steps in plan: ${actionablePlan.execution_plan.length}`
            );
          }
        } else {
          console.warn(`⚠️  Step ${step.step_number} is not a valid API call (path: ${step.api?.path}, method: ${step.api?.method})`);
          console.warn('This appears to be a computation/logic step. The planner should only generate API call steps.');
          console.warn('Skipping this step and will let validator determine if more API calls are needed.');
        }
      }

      console.log(`\n✅ Completed all planned steps. Total executed: ${accumulatedResults.length - progressBeforeExecution}`);

      if (intentType === 'MODIFY' && !hasApiError) {
        console.log('📌 MODIFY flow: All steps executed without errors. Validating goal completion...');

        const allMatchedApis = await getAllMatchedApis({ entities, intentType, context: requestContext });
        const topKResults = await getTopKResults(allMatchedApis, 20);
        const str = serializeUsefulDataInOrder(requestContext);

        const validationResult = await validateNeedMoreActions(
          refinedQuery,
          sanitizeForValidation(executedSteps),
          sanitizeForValidation(accumulatedResults),
          apiKey,
          actionablePlan
        );

        console.log('Post-execution validation result:', validationResult);

        if (!validationResult.needsMoreActions) {
          console.log('✅ MODIFY validation confirmed: goal is complete');
          if (validationResult.item_not_found) {
            stoppedReason = 'item_not_found';
          }
          break;
        } else {
          console.log(`⚠️  MODIFY validation failed: ${validationResult.reason}`);

          const plannerContext = `
Original Query: ${refinedQuery}

Executed Actions:
${JSON.stringify(executedSteps, null, 2)}

Results from Execution:
${JSON.stringify(accumulatedResults, null, 2)}

Goal Completion Status:
The user's goal has NOT been fully completed. Here's why:
${validationResult.reason}

Missing Requirements:
${JSON.stringify(validationResult.missing_requirements, null, 2)}

Suggested Next Action:
${validationResult.suggested_next_action || 'Generate a new plan to complete the goal'}

Available APIs:
${JSON.stringify(topKResults.slice(0, 10), null, 2)}

Reference task (reuse if similar): ${referenceTask ? JSON.stringify({ id: referenceTask.id, taskName: referenceTask.taskName }) : 'N/A'}

Please generate a NEW PLAN to complete the user's goal.`;

          currentPlanResponse = await sendToPlanner(plannerContext, str, conversationContextWithReference, intentType);
          actionablePlan = JSON.parse(sanitizePlannerResponse(currentPlanResponse));
          console.log('✅ Generated new plan from validation feedback (MODIFY re-plan)');
          continue;
        }
      } else if (intentType === 'MODIFY' && hasApiError) {
        console.log('🔄 MODIFY flow error detected. Re-planning with error feedback...');

        const allMatchedApis = await getAllMatchedApis({ entities, intentType, context: requestContext });
        const topKResults = await getTopKResults(allMatchedApis, 20);
        const str = serializeUsefulDataInOrder(requestContext);

        const lastExecutedStep = executedSteps[executedSteps.length - 1];
        const errorDetails = lastExecutedStep?.response?.message || 'Unknown error';

        const plannerContext = `
Original Query: ${refinedQuery}

Previous Plan Failed:
The following action encountered an error and was not completed:
Step ${lastExecutedStep?.step?.step_number}: ${lastExecutedStep?.step?.description}
API: ${lastExecutedStep?.step?.api?.method?.toUpperCase()} ${lastExecutedStep?.step?.api?.path}
Error: ${errorDetails} (Status: ${lastExecutedStep?.response?.statusCode})

Executed Steps Before Error:
${JSON.stringify(executedSteps.slice(0, -1), null, 2)}

Available APIs:
${JSON.stringify(topKResults.slice(0, 10), null, 2)}

Reference task (reuse if similar): ${referenceTask ? JSON.stringify({ id: referenceTask.id, taskName: referenceTask.taskName }) : 'N/A'}

Please generate a NEW PLAN that avoids the failed action and finds an alternative approach.`;

        currentPlanResponse = await sendToPlanner(plannerContext, str, conversationContextWithReference, intentType);
        actionablePlan = JSON.parse(sanitizePlannerResponse(currentPlanResponse));
        console.log('✅ Generated new plan after error (MODIFY recovery)');
        continue;
      }

      // FETCH flow validation
      if (intentType === 'FETCH') {
        const progressMade = accumulatedResults.length > progressBeforeExecution;

        if (!progressMade) {
          stuckCount++;
          console.warn(`⚠️  No progress made in this iteration (stuck count: ${stuckCount})`);

          if (referenceTask && stuckCount >= 1) {
            console.warn('⏹️  Short-circuiting iterative loop: reference task provided but no progress made.');
            stoppedReason = 'stuck_state';
            break;
          }

          if (stuckCount >= 2) {
            console.warn('Detected stuck state: no new API calls in 2 consecutive iterations');
            break;
          }
        } else {
          stuckCount = 0;
        }

        console.log('\n🔍 FETCH flow: Validating if more actions are needed...');

        const validationResult = await validateNeedMoreActions(
          refinedQuery,
          sanitizeForValidation(executedSteps),
          sanitizeForValidation(accumulatedResults),
          apiKey,
          actionablePlan
        );

        console.log('Validation result:', validationResult);

        if (!validationResult.needsMoreActions) {
          console.log('✅ Validator confirmed: sufficient information gathered');
          if (validationResult.item_not_found) {
            console.log('❌ Item not found - will generate answer explaining this');
            stoppedReason = 'item_not_found';
          }
          break;
        }

        console.log(`⚠️  Validator says more actions needed: ${validationResult.reason}`);

        const allMatchedApis = await getAllMatchedApis({ entities, intentType, context: requestContext });
        const topKResults = await getTopKResults(allMatchedApis, 20);
        const str = serializeUsefulDataInOrder(requestContext);

        const plannerContext = `
Original Query: ${refinedQuery}

Matched APIs Available: ${JSON.stringify(topKResults.slice(0, 10), null, 2)}

Executed Steps So Far: ${JSON.stringify(executedSteps, null, 2)}

Accumulated Results: ${JSON.stringify(accumulatedResults, null, 2)}

Previous Plan: ${JSON.stringify(actionablePlan, null, 2)}

The validator says more actions are needed: ${validationResult.suggested_next_action ? validationResult.suggested_next_action : validationResult.reason}

Useful data from execution history that could help: ${validationResult.useful_data ? validationResult.useful_data : 'N/A'}

Reference task (reuse if similar): ${referenceTask ? JSON.stringify({ id: referenceTask.id, taskName: referenceTask.taskName }) : 'N/A'}

IMPORTANT: If the available APIs do not include an endpoint that can provide the required information:
1. Check if any of the accumulated results contain the information in a different format
2. Consider if the data can be derived or inferred from existing results
3. If truly impossible with available APIs, set needs_clarification: true with reason explaining what API is missing

Please generate the next step in the plan, or indicate that no more steps are needed.`;

        currentPlanResponse = await sendToPlanner(plannerContext, str, conversationContextWithReference, intentType);
        actionablePlan = JSON.parse(sanitizePlannerResponse(currentPlanResponse));
        console.log('\n🔄 Generated new plan from validator feedback (FETCH mode)');
      }
    } catch (error: any) {
      console.error('Error during iterative planner execution:', error);
      return {
        error: 'Failed during iterative execution',
        details: error.message,
        executedSteps,
        accumulatedResults,
        usefulData,
      };
    }
  }

  if (iteration >= maxIterations) {
    console.warn(`Reached max API call limit (${maxIterations})`);
    stoppedReason = 'max_iterations';
  } else if (planIteration >= 20) {
    console.warn('Reached max planning cycles (20)');
    stoppedReason = 'max_planning_cycles';
  } else if (stuckCount >= 2) {
    console.warn('Stopped due to stuck state (repeated validation reasons)');
    stoppedReason = 'stuck_state';
  }

  console.log(`\n📊 Execution Summary:`);
  console.log(`  - Total API calls made: ${iteration}/${maxIterations}`);
  console.log(`  - Planning cycles: ${planIteration}`);
  console.log(`  - Stopped reason: ${stoppedReason || 'goal_completed'}`);

  console.log('\n' + '='.repeat(80));
  console.log('📝 GENERATING FINAL ANSWER');
  console.log('='.repeat(80));

  function sanitizeForFinalAnswer(obj: any): any {
    const seen = new WeakSet();
    return JSON.parse(
      JSON.stringify(obj, (key, value) => {
        if (typeof value === 'object' && value !== null) {
          if (seen.has(value)) return '[Circular]';
          seen.add(value);
          if (key === 'request' || key === 'socket' || key === 'agent' || key === 'res') return '[Omitted]';
          if (key === 'config') return { method: value.method, url: value.url, data: value.data };
          if (key === 'headers' && value.constructor?.name === 'AxiosHeaders') {
            return Object.fromEntries(Object.entries(value));
          }
        }
        return value;
      })
    );
  }

  const sanitizedAccumulatedResults = sanitizeForFinalAnswer(accumulatedResults);

  const preparedResults = sanitizedAccumulatedResults.map((result: any) => {
    const response = result.response;

    if (response && response.result) {
      const resultData = response.result;

      if (resultData.moves && Array.isArray(resultData.moves) && resultData.moves.length > 10) {
        console.log(`Processing ${resultData.moves.length} moves for final answer`);

        const queryLower = refinedQuery.toLowerCase();
        let filteredMoves = resultData.moves;

        const typeKeywords = [
          'steel', 'fire', 'water', 'electric', 'grass', 'ice', 'fighting', 'poison', 'ground',
          'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'fairy', 'normal',
        ];
        const mentionedType = typeKeywords.find(type => queryLower.includes(type));

        if (mentionedType) {
          const relevantMoves = resultData.moves.filter(
            (move: any) =>
              move.type_name?.toLowerCase() === mentionedType ||
              move.typeName?.toLowerCase() === mentionedType
          );
          console.log(`Filtered to ${relevantMoves.length} ${mentionedType}-type moves`);
          if (relevantMoves.length > 0) filteredMoves = relevantMoves;
        }

        return {
          ...result,
          response: {
            ...response,
            result: {
              ...resultData,
              moves: filteredMoves,
              movesCount: resultData.moves.length,
              filteredMovesCount: filteredMoves.length,
              movesNote: mentionedType
                ? `Filtered to ${filteredMoves.length} ${mentionedType}-type moves out of ${resultData.moves.length} total`
                : `All ${filteredMoves.length} moves included`,
            },
          },
        };
      }
    }

    return result;
  });

  const str = serializeUsefulDataInOrder(requestContext);

  const finalAnswer = await generateFinalAnswer(
    refinedQuery,
    preparedResults,
    apiKey,
    stoppedReason,
    str
  );

  console.log('\n' + '='.repeat(80));
  console.log('✅ ITERATIVE PLANNER COMPLETED');
  console.log('='.repeat(80));

  return {
    message: finalAnswer,
    executedSteps,
    accumulatedResults,
    usefulData,
    iterations: iteration,
  };
}
