/**
 * plannerUtils.ts
 * Functions for building and sanitizing execution plans.
 * SQL generation path removed — the app now relies purely on PokéAPI tools.
 */
import jaison from '@/utils/jaison';
import { RequestContext } from '@/services/chatPlannerService';
import { SavedTask } from '@/services/taskService';
import { sendToPlanner } from './planner';

/**
 * Prepares planner inputs, calls sendToPlanner, and returns a parsed actionable plan.
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
  console.log(`🔀 Planner routing: intentType=${intentType}`);

  // Fast path: reuse a saved reference task's plan if available
  if (
    referenceTask &&
    referenceTask.steps &&
    Array.isArray(referenceTask.steps) &&
    referenceTask.steps.length > 0
  ) {
    console.log(`✨ FAST PATH: Using reference task plan (${referenceTask.steps.length} steps)`);

    const executionPlan = referenceTask.steps.map((step: any) => {
      const contentMatch = step.stepContent?.match(/—\s*(\w+)\s+(.+?)$/);
      const method = contentMatch ? contentMatch[1].toLowerCase() : 'get';
      const path = contentMatch ? contentMatch[2].trim() : '/pokemon';

      return {
        step_number: step.stepOrder || 1,
        description: step.stepContent || `Step ${step.stepOrder}`,
        api: { path, method, parameters: {}, requestBody: {} },
        stepType: step.stepType,
      };
    });

    const actionablePlan = {
      needs_clarification: false,
      phase: 'execution',
      final_deliverable: finalDeliverable || '',
      execution_plan: executionPlan,
      selected_tools_spec: [],
      _from_reference_task: true,
      _reference_task_id: referenceTask.id,
    };

    const planResponse = JSON.stringify(actionablePlan);
    console.log('🪄 Using reference plan:', planResponse);
    return { actionablePlan, planResponse };
  }

  // Normal path: call the LLM planner
  let planResponse = await sendToPlanner(refinedQuery, usefulData, conversationContext, intentType);

  let actionablePlan;
  try {
    const sanitizedPlanResponse = sanitizePlannerResponse(planResponse);
    actionablePlan = JSON.parse(sanitizedPlanResponse);

    if (actionablePlan && finalDeliverable) {
      actionablePlan.final_deliverable = finalDeliverable;
    }
    if (actionablePlan) {
      delete actionablePlan._replanned;
      delete actionablePlan._replan_reason;
    }

    if (actionablePlan?.impossible) {
      console.log('🚫 Planner marked task as impossible.');
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
    console.log('♻️ Plan is resolution-only for MODIFY intent; re-planning with forceFullPlan=true...');
    const retryResponse = await sendToPlanner(refinedQuery, usefulData, conversationContext, 'MODIFY', true);
    const sanitizedRetry = sanitizePlannerResponse(retryResponse);
    actionablePlan = JSON.parse(sanitizedRetry);
    planResponse = retryResponse;
    if (actionablePlan && finalDeliverable) {
      actionablePlan.final_deliverable = finalDeliverable;
    }
  }

  return { actionablePlan, planResponse };
}

/**
 * Sanitizes a raw planner response string into valid JSON using jaison.
 */
export function sanitizePlannerResponse(response: string): string {
  try {
    const firstMatch = response.match(/\{[\s\S]*\}|\[[\s\S]*\]/);
    if (!firstMatch) throw new Error('No JSON object or array found in the response.');
    const jsonFixed = jaison(firstMatch[0]);
    if (jsonFixed) return JSON.stringify(jsonFixed);
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
    if (typeof value === 'string') return placeholderPattern.test(value);
    if (typeof value === 'object' && value !== null) {
      if (Array.isArray(value)) return value.some(checkValue);
      return Object.values(value).some(checkValue);
    }
    return false;
  };

  return checkValue(obj);
}

/**
 * Resolves "resolved_from_step_X" placeholders by extracting values from previously
 * executed steps using an LLM call.
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
    const checkBody = (obj: any, bodyPath: string = ''): boolean => {
      for (const [key, value] of Object.entries(obj || {})) {
        const fullPath = bodyPath ? `${bodyPath}.${key}` : key;
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

  if (!foundPlaceholder || placeholderStepNum === null) return { resolved: true };

  const referencedStep = executedSteps.find(
    (s) => s.step === placeholderStepNum || s.stepNumber === placeholderStepNum || s.step?.step_number === placeholderStepNum
  );

  if (!referencedStep) {
    const reason = `Referenced step ${placeholderStepNum} has not been executed yet`;
    console.error(`❌ ${reason}`);
    return { resolved: false, reason };
  }

  const apiKey_local = process.env.NEXT_PUBLIC_OPENAI_API_KEY;
  if (!apiKey_local) return { resolved: false, reason: 'OpenAI API key not configured' };

  // Inline import to avoid circular deps
  const { openaiChatCompletion } = await import('@/utils/aiHandler');

  try {
    const extractedValue = await openaiChatCompletion({
      messages: [
        {
          role: 'system',
          content: `Extract the value to replace "resolved_from_step_${placeholderStepNum}" from the previous step's response.
Return ONLY the raw value (no JSON, no explanation).
If not found, return "ERROR: not found".

Current step API path: ${stepToExecute.api?.path}
Previous step response:
${JSON.stringify(referencedStep.response, null, 2)}`,
        },
      ],
      temperature: 0.2,
      max_tokens: 100,
    });

    console.log(`✅ Extracted placeholder value: "${extractedValue}"`);
    if (!extractedValue || extractedValue.startsWith('ERROR:')) {
      return { resolved: false, reason: `Failed to extract value: ${extractedValue}` };
    }

    if (stepToExecute.api?.parameters) {
      for (const [key, value] of Object.entries(stepToExecute.api.parameters)) {
        if (typeof value === 'string' && value.includes(`resolved_from_step_${placeholderStepNum}`)) {
          stepToExecute.api.parameters[key] = extractedValue;
        }
      }
    }

    if (stepToExecute.api?.requestBody) {
      const replaceInBody = (obj: any): void => {
        for (const [key, value] of Object.entries(obj || {})) {
          if (typeof value === 'string' && value.includes(`resolved_from_step_${placeholderStepNum}`)) {
            obj[key] = obj[key].replace(`resolved_from_step_${placeholderStepNum}`, extractedValue);
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
