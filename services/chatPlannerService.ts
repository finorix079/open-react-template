/**
 * chatPlannerService.ts
 * PokéAPI RAG retrieval and planner support utilities.
 *
 * The old embedding-based retrieval (OpenAI ada-002 embeddings against vectorized
 * ElasticDash schemas) has been replaced with a static PokéAPI tool catalog
 * via getMatchedPokemonTools(). No external embedding API calls are made.
 */

import { openaiChatCompletion } from '@/utils/aiHandler';
import fs from 'fs';
import path from 'path';
import jaison from '@/utils/jaison';
import { getMatchedPokemonTools } from '@/services/pokemonRagService';

// Request-scoped context to prevent race conditions between concurrent requests
export interface RequestContext {
  ragEntity?: string;
  flatUsefulDataMap: Map<string, any>;
  usefulDataArray: Array<{ key: string; data: string; timestamp: number }>;
}

export interface Message {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

/**
 * Returns all PokéAPI tools matched to the given entities using keyword scoring.
 * Replaces the old embedding-based retrieval (OpenAI ada-002 + cosine similarity
 * against vectorized ElasticDash DB schemas / REST API specs).
 *
 * All operations against PokéAPI are read-only, so intentType is accepted for
 * interface compatibility but does not change the tool set returned.
 */
export async function getAllMatchedApis({
  entities,
  intentType,
  context,
}: {
  entities: string[];
  intentType: 'FETCH' | 'MODIFY';
  context?: RequestContext;
}): Promise<Map<string, any>> {
  console.log(`🔎 PokéAPI RAG: keyword matching for entities=[${entities.join(', ')}], intent=${intentType}`);
  const allMatchedApis = new Map<string, any>();

  const tools = getMatchedPokemonTools(entities);
  for (const tool of tools) {
    allMatchedApis.set(tool.id, tool);
  }

  console.log(`✅ PokéAPI RAG: matched ${allMatchedApis.size} tools`);
  return allMatchedApis;
}

/** Returns the top-K entries from the matched APIs map, sorted by similarity. */
export async function getTopKResults(allMatchedApis: Map<string, any>, topK: number): Promise<any[]> {
  const results = Array.from(allMatchedApis.values())
    .sort((a: any, b: any) => b.similarity - a.similarity)
    .slice(0, topK)
    .map((item: any) => ({
      id: item.id,
      summary: item.summary,
      tags: item.tags,
      content: item.content,
    }));

  console.log(`\n✅ Top ${results.length} tools selected:`, results.map((t: any) => t.id));
  return results;
}

/** Reads a prompt file from src/doc/. */
export async function fetchPromptFile(fileName: string): Promise<string> {
  try {
    return fs.readFileSync(path.join(process.cwd(), 'src', 'doc', fileName), 'utf-8');
  } catch (error: any) {
    throw new Error(`Error fetching prompt file: ${error.message}`);
  }
}

/** Extracts the primary entity name from a refined query string. */
export function detectEntityName(refinedQuery: string): string | undefined {
  const text = refinedQuery || '';
  const quoted = text.match(/['"]([^'"]+)['"]/);
  if (quoted) return quoted[1];
  const verbNoun = text.match(/\b(?:add|remove|delete|drop|clear)\s+([A-Za-z0-9_-]+)/i);
  if (verbNoun) return verbNoun[1];
  const lastToken = text.trim().split(/\s+/).pop();
  return lastToken && lastToken.length > 1 ? lastToken : undefined;
}

export function deepClone<T>(obj: T): T {
  return JSON.parse(JSON.stringify(obj || {}));
}

export function replaceInObject(obj: any, search: string, replacement: string) {
  if (typeof obj !== 'object' || obj === null) return;
  Object.keys(obj).forEach((key) => {
    if (typeof obj[key] === 'string') {
      obj[key] = obj[key].replace(new RegExp(search, 'gi'), replacement);
    } else if (typeof obj[key] === 'object') {
      replaceInObject(obj[key], search, replacement);
    }
  });
}

export function substituteApiPlaceholders(
  api: any,
  refinedQuery: string,
  fallback: { path: string; method: string }
) {
  const entityName = detectEntityName(refinedQuery);
  const method = (api?.method || fallback.method || 'get').toLowerCase();
  let apiPath = api?.path || fallback.path || '/pokemon';
  const parameters = deepClone(api?.parameters || {});
  const requestBody = deepClone(api?.requestBody || {});

  if (entityName) {
    replaceInObject(parameters, '{POKEMON_NAME}', entityName);
    replaceInObject(requestBody, '{POKEMON_NAME}', entityName);
    apiPath = apiPath.replace(/\{POKEMON_NAME\}/g, entityName);
  }

  return { path: apiPath, method, parameters, requestBody };
}

/** Serializes the request context's useful data array in chronological order. */
export function serializeUsefulDataInOrder(context: RequestContext): string {
  if (!context.usefulDataArray || context.usefulDataArray.length === 0) {
    return '{}';
  }
  const orderedEntries: Array<[string, string]> = context.usefulDataArray
    .sort((a, b) => a.timestamp - b.timestamp)
    .map((item) => [item.key, item.data]);
  return JSON.stringify(Object.fromEntries(orderedEntries), null, 2);
}

export function extractJSON(content: string): { json: string; text: string } | null {
  try {
    const trimmed = content.trim();
    let jsonStart = -1;
    let jsonEnd = -1;
    const objStart = trimmed.indexOf('{');
    const arrStart = trimmed.indexOf('[');

    if (objStart === -1 && arrStart === -1) return null;

    if (objStart !== -1 && (arrStart === -1 || objStart < arrStart)) {
      jsonStart = objStart;
      let depth = 0;
      for (let i = objStart; i < trimmed.length; i++) {
        if (trimmed[i] === '{') depth++;
        if (trimmed[i] === '}') depth--;
        if (depth === 0) { jsonEnd = i + 1; break; }
      }
    } else if (arrStart !== -1) {
      jsonStart = arrStart;
      let depth = 0;
      for (let i = arrStart; i < trimmed.length; i++) {
        if (trimmed[i] === '[') depth++;
        if (trimmed[i] === ']') depth--;
        if (depth === 0) { jsonEnd = i + 1; break; }
      }
    }

    if (jsonStart === -1 || jsonEnd === -1) return null;
    const json = trimmed.substring(jsonStart, jsonEnd);
    const text = trimmed.substring(0, jsonStart).trim();
    JSON.parse(json);
    return { json, text };
  } catch {
    return null;
  }
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

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

  console.log(`\n📋 RESOLVING PLACEHOLDER: resolved_from_step_${placeholderStepNum}`);

  try {
    const extractedValue = await openaiChatCompletion({
      messages: [
        {
          role: 'system',
          content: `You are a data extraction expert. Extract the correct value to replace a "resolved_from_step_X" placeholder.

RULES:
1. Analyze the current step's API call to understand what value is needed
2. Look at the referenced step's response to find the matching data
3. Return ONLY the extracted value (no explanation, no JSON wrapping)
4. If the data cannot be found, return "ERROR: [reason]"

Current Step:
- API Path: ${stepToExecute.api?.path}
- Parameters: ${JSON.stringify(stepToExecute.api?.parameters || {})}

Previous Step (Step ${placeholderStepNum}) Response:
${JSON.stringify(referencedStep.response, null, 2)}

Return ONLY the value to substitute:`,
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
