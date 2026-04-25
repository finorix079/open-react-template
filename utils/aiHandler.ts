// --- Agentic Tool Definitions ---
import OpenAI from 'openai';
import { generateText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WrapAIFn = <T extends (...args: any[]) => any>(name: string, fn: T, options?: { model?: string; provider?: string }) => T;
// Use the real wrapAI from elasticdash-test (supports AI mocking and auto-telemetry).
// Falls back to a passthrough stub if the package is unavailable at runtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wrapAI: WrapAIFn = (_name: string, fn: any) => fn;
try {
  // eval('require') bypasses Turbopack's static analysis which shows "Module not found"
  // for serverExternalPackages entries and replaces require() with an error stub at runtime.
  // Node.js resolves elasticdash-test natively via the CJS export (dist/index.cjs).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrapAI = (eval('require') as (id: string) => any)('elasticdash-test').wrapAI ?? wrapAI;
} catch {
  // Not in elasticdash context — passthrough stub remains active
}
import { NodeSDK } from "@opentelemetry/sdk-node";
import { observeOpenAI } from "@langfuse/openai";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseObservation, LangfuseSpan, LangfuseTool } from "@langfuse/tracing";
import { startActiveObservation } from "@langfuse/tracing";
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import {
  apiService,
  // checkApprovalStatus,
  // dataService,
  fetchPokemonDetails,
  queryRefinement,
  searchAbility,
  searchBerry,
  searchMove,
  searchPokemon,
} from '@/ed_tools';

async function executeWithObservation(
  parentObs: LangfuseObservation,
  toolName: string,
  input: any,
  fn: () => Promise<any>
): Promise<any> {
  const toolObs: LangfuseTool = parentObs.startObservation(toolName, {
    input,
  }, { asType: "tool" });
  try {
    const output = await fn();
    toolObs.update({ output });
    toolObs.end();
    return output;
  } catch (err) {
    toolObs
	.update({ 
		level: 'ERROR', 
		statusMessage: (err as Error).message,
	})
	.end();
    throw err;
  }
}

export interface AgentTool {
  name: string;
  execute: (input: any, parentObs: LangfuseObservation) => Promise<unknown>;
  description?: string;
}

export const agentTools: Record<string, AgentTool> = {
	apiService: {
		name: "apiService",
		async execute(input: any, parentObs: LangfuseObservation): Promise<unknown> {
			return executeWithObservation(parentObs, "apiService", input, async () => {
				// const typedInput = input as { baseUrl: string; schema: any; userToken?: string };
				return await apiService(input);
			});
		},
		description: "Dynamic API request tool",
	},
	queryRefinement: {
		name: "queryRefinement",
		async execute(input: any, parentObs: LangfuseObservation): Promise<unknown> {
			return executeWithObservation(parentObs, "queryRefinement", input, async () => {
				// const typedInput = input as { userInput: string; userToken?: string };
				return await queryRefinement(input);
			});
		},
		description: "Refine and clarify user queries",
	},
	searchPokemon: {
		name: "searchPokemon",
		async execute(input: any, parentObs: LangfuseObservation): Promise<unknown> {
			return executeWithObservation(parentObs, "searchPokemon", input, async () => {
				return await searchPokemon(input);
			});
		},
		description: "Search Pokémon by name or list by page via PokéAPI",
	},
	fetchPokemonDetails: {
		name: "fetchPokemonDetails",
		async execute(input: any, parentObs: LangfuseObservation): Promise<unknown> {
			return executeWithObservation(parentObs, "fetchPokemonDetails", input, async () => {
				return await fetchPokemonDetails(input);
			});
		},
		description: "Fetch full Pokémon details (stats, types, abilities, moves) via PokéAPI",
	},
	searchMove: {
		name: "searchMove",
		async execute(input: any, parentObs: LangfuseObservation): Promise<unknown> {
			return executeWithObservation(parentObs, "searchMove", input, async () => {
				return await searchMove(input);
			});
		},
		description: "Search moves by name or list by page via PokéAPI",
	},
	searchBerry: {
		name: "searchBerry",
		async execute(input: any, parentObs: LangfuseObservation): Promise<unknown> {
			return executeWithObservation(parentObs, "searchBerry", input, async () => {
				return await searchBerry(input);
			});
		},
		description: "Search berries by name or list by page via PokéAPI",
	},
	searchAbility: {
		name: "searchAbility",
		async execute(input: any, parentObs: LangfuseObservation): Promise<unknown> {
			return executeWithObservation(parentObs, "searchAbility", input, async () => {
				return await searchAbility(input);
			});
		},
		description: "Search abilities by name or list by page via PokéAPI",
	},
	// checkApprovalStatus: {
	// 	name: "checkApprovalStatus",
	// 	async execute(input: any, parentObs: LangfuseObservation): Promise<unknown> {
	// 		return executeWithObservation(parentObs, "checkApprovalStatus", input, async () => {
	// 			return await checkApprovalStatus(input);
	// 		});
	// 	},
	// 	description: "Check whether a pending plan has been approved or rejected by the user",
	// },
};

// ============================================================
// Agent interfaces
// ============================================================

/**
 * Single step in an agent's execution plan.
 * Fully JSON-serializable — `tool` is a string key into `agentTools`.
 */
export interface AgentTask {
  /** Unique task identifier within the plan */
  id: string;
  /** Human-readable description of what this task does */
  description: string;
  /** Tool name — must be a key in `agentTools` (e.g. 'apiService', 'dataService') */
  tool: string;
  /** Task input; may contain `{$task.N.output[.path]}` placeholders */
  input: unknown;
  /** Populated after execution */
  output?: unknown;
  status: 'pending' | 'in-progress' | 'completed' | 'failed';
  /** Unix ms timestamp when this task started */
  startedAt?: number;
  /** Unix ms timestamp when this task finished */
  completedAt?: number;
  /** Error message if the task failed */
  error?: string;
}

/**
 * Full agent execution plan. All fields are required to enable safe
 * serialization and mid-trace resumption.
 */
export interface AgentPlan {
  /** Unique plan identifier */
  id: string;
  /** High-level goal for this plan */
  goal: string;
  tasks: AgentTask[];
  status: 'planning' | 'executing' | 'completed' | 'failed' | 'paused';
  /** Zero-based index of the task currently being executed */
  currentTaskIndex: number;
  /** Shared data accessible to all tasks */
  context: Record<string, unknown>;
  /** Additional metadata (session ID, user query, timing, etc.) */
  metadata: Record<string, unknown>;
}

// ============================================================
// Mid-Trace Replay types
// ============================================================

/**
 * A workflow trace event captured during agent execution.
 *
 * During workflow live reruns `agentTaskId` and `agentTaskIndex` are populated
 * so the dashboard can group events by agent task and show the
 * "Resume from Task N" button.
 */
export interface WorkflowEvent {
  taskId: string;
  toolName: string;
  input: unknown;
  output: unknown;
  status: 'completed' | 'failed';
  startedAt?: number;
  completedAt?: number;
  error?: string;
  /** Identifies the owning agent task — populated during workflow reruns only */
  agentTaskId?: string;
  /** Zero-based index of the owning agent task — populated during workflow reruns only */
  agentTaskIndex?: number;
}

/**
 * Complete, JSON-serializable agent state for mid-trace resumption.
 *
 * @example
 * // Save state after (partial) execution
 * const state = serializeAgentState(completedPlan);
 * fs.writeFileSync('state.json', JSON.stringify(state, null, 2));
 *
 * // Later: resume from task 2
 * const saved = JSON.parse(fs.readFileSync('state.json', 'utf8'));
 * const resumed = await resumeAgentFromTrace({ ...saved, resumeFromTaskIndex: 2 });
 */
export interface AgentState {
  /** Full plan including tasks with their captured outputs */
  plan: AgentPlan;
  /** Trace events captured during previous execution */
  trace: WorkflowEvent[];
  /** Zero-based index — tasks before this index are loaded from cache on resume */
  resumeFromTaskIndex: number;
}

// ============================================================
// Mid-Trace Replay utilities
// ============================================================

/**
 * Extracts all task outputs into a flat map keyed by both the zero-based task
 * index (as a string) and the task id.  Used internally by `resolveTaskInput`
 * to resolve `{$task.N.output.path}` placeholders.
 *
 * @param plan - Plan whose tasks may carry outputs
 * @returns `{ "0": output0, "task-1": output0, "1": output1, ... }`
 */
export function extractTaskOutputs(plan: AgentPlan): Record<string, unknown> {
  const outputs: Record<string, unknown> = {};
  plan.tasks.forEach((task, index) => {
    if (task.output !== undefined) {
      outputs[String(index)] = task.output;
      outputs[task.id] = task.output;
    }
  });
  return outputs;
}

/**
 * Recursively resolves `{$task.N.output[.dotPath]}` placeholders embedded in a
 * task input value.
 *
 * Placeholder format: `{$task.<zeroBasedIndex>.output[.<dotSeparatedPath>]}`
 *
 * Examples:
 * - `"{$task.0.output}"` → full output of task 0 (returns original type)
 * - `"{$task.1.output.embedding}"` → `embedding` field of task 1's output
 * - Objects and arrays are traversed recursively
 * - A placeholder that occupies the **entire** string value returns the
 *   resolved value with its original type (e.g. number, array).
 * - A placeholder embedded in a larger string is stringified inline.
 *
 * @param input - Raw input value (string, object, array, or primitive)
 * @param previousOutputs - Output map from `extractTaskOutputs`
 * @returns Input with all placeholders replaced by real values
 * @throws Error if a placeholder references a task with no recorded output
 */
export function resolveTaskInput(
  input: unknown,
  previousOutputs: Record<string, unknown>,
): unknown {
  const PLACEHOLDER_RE = /\{\$task\.(\d+)\.output(?:\.([^}]+))?\}/g;

  function walkPath(root: unknown, path: string, taskIndex: string): unknown {
    const parts = path.split('.');
    let cursor: unknown = root;
    for (const part of parts) {
      if (cursor === null || cursor === undefined || typeof cursor !== 'object') {
        throw new Error(
          `resolveTaskInput: cannot traverse path "${path}" for task ${taskIndex} — reached non-object at "${part}"`,
        );
      }
      cursor = (cursor as Record<string, unknown>)[part];
    }
    return cursor;
  }

  function resolveString(str: string): unknown {
    // Single full-string placeholder → preserve original type
    const singleMatch = str.match(/^\{\$task\.(\d+)\.output(?:\.([^}]+))?\}$/);
    if (singleMatch) {
      const [, index, path] = singleMatch;
      const taskOutput = previousOutputs[index];
      if (taskOutput === undefined) {
        throw new Error(`resolveTaskInput: no output found for task index ${index}`);
      }
      return path ? walkPath(taskOutput, path, index) : taskOutput;
    }
    // Inline placeholders — stringify resolved values
    return str.replace(PLACEHOLDER_RE, (_, index, path) => {
      const taskOutput = previousOutputs[index];
      if (taskOutput === undefined) {
        throw new Error(`resolveTaskInput: no output found for task index ${index}`);
      }
      const value = path ? walkPath(taskOutput, path, index) : taskOutput;
      return value !== undefined ? String(value) : '';
    });
  }

  function deepResolve(val: unknown): unknown {
    if (typeof val === 'string') return resolveString(val);
    if (Array.isArray(val)) return val.map(deepResolve);
    if (typeof val === 'object' && val !== null) {
      const obj = val as Record<string, unknown>;
      // Support elasticdash-test's { $ref: "taskId.output.path" } object format
      if (typeof obj['$ref'] === 'string') {
        const ref = obj['$ref'] as string;
        const parts = ref.split('.');
        const taskId = parts[0];
        const pathParts = parts.slice(1); // may include literal "output" keyword
        let cursor: unknown = previousOutputs[taskId];
        for (const part of pathParts) {
          if (part === 'output') continue; // "output" is a keyword separator, skip
          if (cursor === null || cursor === undefined) return undefined;
          cursor = (cursor as Record<string, unknown>)[part];
        }
        return cursor;
      }
      const resolved: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(obj)) {
        resolved[k] = deepResolve(v);
      }
      return resolved;
    }
    return val;
  }

  return deepResolve(input);
}

/**
 * Serializes a (partial or complete) `AgentPlan` and optional trace events into
 * an `AgentState`.  The `resumeFromTaskIndex` is automatically determined as the
 * index of the first non-completed task (or `tasks.length` if all tasks are done).
 *
 * @param plan - Plan after execution (tasks may be partially completed)
 * @param trace - Optional trace events recorded during execution
 * @returns JSON-serializable `AgentState`
 */
export function serializeAgentState(
  plan: AgentPlan,
  trace: WorkflowEvent[] = [],
): AgentState {
  const firstIncomplete = plan.tasks.findIndex((t) => t.status !== 'completed');
  const resumeFromTaskIndex = firstIncomplete === -1 ? plan.tasks.length : firstIncomplete;
  return {
    plan: { ...plan, tasks: plan.tasks.map((t) => ({ ...t })) },
    trace,
    resumeFromTaskIndex,
  };
}

/**
 * Validates and hydrates an `AgentState` loaded from JSON.
 *
 * Accepts `unknown` input (e.g. `JSON.parse(...)`) and validates that:
 * - `plan.tasks` is a valid array
 * - All tasks before `resumeFromTaskIndex` that are marked `completed` have
 *   an output (needed for placeholder resolution)
 * - All referenced tool names exist in `agentTools`
 *
 * @param raw - Raw parsed value (e.g. from `JSON.parse`)
 * @returns The validated `AgentState` (same structure, guaranteed safe to resume)
 * @throws Error if any validation check fails
 */
export function deserializeAgentState(raw: unknown): AgentState {
  if (!raw || typeof raw !== 'object') {
    throw new Error('deserializeAgentState: state must be a non-null object');
  }
  const state = raw as Record<string, unknown>;
  const plan = state['plan'] as AgentPlan | undefined;
  if (!plan || !Array.isArray(plan.tasks)) {
    throw new Error('deserializeAgentState: invalid state — missing plan.tasks');
  }
  const resumeFromTaskIndex =
    typeof state['resumeFromTaskIndex'] === 'number' ? state['resumeFromTaskIndex'] : 0;
  const trace = Array.isArray(state['trace']) ? (state['trace'] as WorkflowEvent[]) : [];
  for (let i = 0; i < Math.min(resumeFromTaskIndex, plan.tasks.length); i++) {
    const task = plan.tasks[i];
    if (!task) continue;
    if (task.status === 'completed' && task.output === undefined) {
      throw new Error(
        `deserializeAgentState: task "${task.id}" is marked completed but has no output`,
      );
    }
    if (!agentTools[task.tool]) {
      throw new Error(
        `deserializeAgentState: unknown tool "${task.tool}" for task "${task.id}"`,
      );
    }
  }
  return { plan, trace, resumeFromTaskIndex };
}

/**
 * Executes an `AgentPlan` sequentially, with optional mid-plan resumption.
 *
 * - Tasks at index < `resumeFrom` are **skipped** — their cached outputs are
 *   preserved and used for placeholder resolution in subsequent tasks.
 * - `{$task.N.output[.path]}` placeholders in each task's `input` are resolved
 *   just before the task runs.
 * - Observations are created under the currently active Langfuse context.
 *
 * @param plan - `AgentPlan` to execute (mutated in place with statuses/outputs)
 * @param resumeFrom - Zero-based index to start executing from (default `0`)
 * @returns The updated plan with all task statuses and outputs filled in
 */
export async function executorAgent(plan: AgentPlan, resumeFrom = 0): Promise<AgentPlan> {
  return startActiveObservation('executorAgent', async (span: LangfuseSpan) => {
    span.update({ input: { planId: plan.id, goal: plan.goal, resumeFrom } });
    plan.status = 'executing';
    plan.currentTaskIndex = resumeFrom;
    const API_CALL_LIMIT = 50;
    let apiCallCount = 0;
    console.log(
      `[executorAgent] Running plan "${plan.id}" from task ${resumeFrom} (${plan.tasks.length} total)`,
    );

    for (let i = 0; i < plan.tasks.length; i++) {
      const task = plan.tasks[i];
      plan.currentTaskIndex = i;

      if (i < resumeFrom) {
        console.log(`[executorAgent] Skipping cached task "${task.id}" (index ${i})`);
        continue;
      }

      if (apiCallCount >= API_CALL_LIMIT) {
        plan.status = 'failed';
        span.update({
          statusMessage: `API call limit (${API_CALL_LIMIT}) reached`,
          level: 'ERROR',
          output: plan,
        });
        break;
      }

      // Resolve {$task.N.output.path} placeholders against previous outputs
      const previousOutputs = extractTaskOutputs({ ...plan, tasks: plan.tasks.slice(0, i) });
      try {
        task.input = resolveTaskInput(task.input, previousOutputs);
      } catch (err) {
        task.status = 'failed';
        task.error = `Placeholder resolution failed: ${(err as Error).message}`;
        task.completedAt = Date.now();
        apiCallCount++;
        continue;
      }

      task.status = 'in-progress';
      task.startedAt = Date.now();

      const tool = agentTools[task.tool];
      if (!tool) {
        task.status = 'failed';
        task.error = `Unknown tool: "${task.tool}"`;
        task.completedAt = Date.now();
        console.error(`[executorAgent] Unknown tool "${task.tool}" for task "${task.id}"`);
        apiCallCount++;
        continue;
      }

      try {
        task.output = await tool.execute(task.input, span);
        task.status = 'completed';
        task.completedAt = Date.now();
        console.log(`[executorAgent] Completed task "${task.id}"`);
      } catch (err) {
        task.status = 'failed';
        task.error = err instanceof Error ? err.message : String(err);
        task.completedAt = Date.now();
        console.error(`[executorAgent] Task "${task.id}" failed:`, task.error);
      }
      apiCallCount++;
    }

    if (plan.status !== 'failed') {
      plan.status = plan.tasks.every((t) => t.status === 'completed') ? 'completed' : 'failed';
      plan.currentTaskIndex = plan.tasks.length;
    }
    span.update({ output: { planStatus: plan.status } });
    return plan;
  });
}

/**
 * Generates an initial `AgentPlan` from a user query by running a query
 * refinement step to clarify the intent.
 *
 * @param userQuery - Raw user query string
 * @param context - Arbitrary context passed through to the plan (e.g. `{ userToken }`)
 * @returns An `AgentPlan` with the `queryRefinement` task executed
 */
export async function plannerAgent(
  userQuery: string,
  context: Record<string, unknown> = {},
): Promise<AgentPlan> {
  const plan: AgentPlan = {
    id: `plan-${Date.now()}`,
    goal: userQuery,
    status: 'planning',
    currentTaskIndex: 0,
    context,
    metadata: { createdAt: Date.now(), userQuery },
    tasks: [
      {
        id: 'task-planning-1',
        description: 'Refine and clarify user query',
        tool: 'queryRefinement',
        input: { userInput: userQuery, userToken: context['userToken'] },
        status: 'pending',
      },
    ],
  };
  return executorAgent(plan);
}

/**
 * Resumes an agent plan from the task index stored in `state.resumeFromTaskIndex`.
 *
 * Validates the state, then delegates to `executorAgent` which skips all tasks
 * before the resume index (using their cached outputs for placeholder resolution).
 *
 * @param state - Serialized `AgentState` (e.g. from `serializeAgentState`)
 * @returns The completed plan with all outputs filled in
 * @throws Error if state validation fails
 */
export async function resumeAgentFromTrace(state: AgentState): Promise<AgentPlan> {
  const validatedState = deserializeAgentState(state);
  console.log(
    `[resumeAgentFromTrace] Resuming plan "${validatedState.plan.id}" from task ${validatedState.resumeFromTaskIndex}`,
  );
  return executorAgent(validatedState.plan, validatedState.resumeFromTaskIndex);
}

/**
 * Internal Agent interface — kept for compatibility with the object-based agent
 * pattern.  Prefer `plannerAgent()` / `executorAgent()` for new code.
 * @internal
 */
export interface Agent {
  id: string;
  name: string;
  plan: AgentPlan;
  selectTool: (task: AgentTask) => AgentTool;
  executeTask: (task: AgentTask, parentObs: LangfuseObservation) => Promise<AgentTask>;
  run: (rootSpan: LangfuseSpan) => Promise<AgentPlan>;
}

/**
 * Stub agentic flow entry point for custom orchestration.
 * For new code, prefer `executorAgent(plan)` instead.
 */
export async function runAgenticFlow(rootSpan: LangfuseSpan, plan: AgentPlan): Promise<AgentPlan> {
  for (const task of plan.tasks) {
    task.status = 'in-progress';
    const tool = agentTools[task.tool];
    if (!tool) {
      task.status = 'failed';
      task.error = `Unknown tool: "${task.tool}"`;
      continue;
    }
    try {
      task.output = await tool.execute(task.input, rootSpan);
      task.status = 'completed';
    } catch (err) {
      task.status = 'failed';
      task.output = err;
    }
  }
  return plan;
}

try {
  const sdk = new NodeSDK({
    spanProcessors: [new LangfuseSpanProcessor()],
  });
  sdk.start();
} catch {
  // Langfuse/OTel initialization may fail (e.g. missing env vars in subprocess) —
  // non-fatal, tool functions still work without telemetry.
}

export const kimiChatCompletion = wrapAI('kimi-k2', async ({
	messages,
	model = 'kimi-k2-turbo-preview',
	temperature = 0.0,
	max_tokens = 4096,
	systemPrompt = '',
	sessionId,
}: {
	messages: ChatCompletionMessageParam[];
	model?: string;
	temperature?: number;
	max_tokens?: number;
	systemPrompt?: string;
  	sessionId?: string;
}) => {
	model = 'kimi-k2-turbo-preview';
	const openai = new OpenAI({
		apiKey: process.env.KIMI_API_KEY,
		baseURL: "https://api.moonshot.ai/v1",
	});
	const client = observeOpenAI(openai);
	const chatMessages: ChatCompletionMessageParam[] = systemPrompt
		? [{ role: 'system', content: systemPrompt } as ChatCompletionMessageParam, ...messages]
		: messages;
	let response;
	try {
		response = await client.chat.completions.create({
			model,
			messages: chatMessages,
			temperature,
			max_tokens,
			...(sessionId ? { observationOptions: { session: sessionId } } : {}),
		});
		const content = response.choices[0].message?.content?.trim() || '';
		return content;
	} catch (error: unknown) {
		console.error('Error in kimiChatCompletion:', error);
		console.error('Related response: ', response);
		throw new Error(
		typeof error === 'object' && error !== null && 'response' in error
			// @ts-expect-error: error shape from OpenAI SDK
			? error?.response?.data?.error?.message || 'Kimi OpenAI API error'
			: (error as Error).message || 'Kimi OpenAI API error'
		);
	}
}, { model: 'kimi-k2-turbo-preview', provider: 'kimi' });

/**
 * Calls the OpenAI Chat Completion API with the provided parameters.
 * Ensures type safety for message objects.
 *
 * @param messages - Array of chat messages
 * @param model - Model name (default: gpt-4o)
 * @param temperature - Sampling temperature (default: 0.0)
 * @param max_tokens - Maximum tokens in response (default: 256)
 * @param systemPrompt - Optional system prompt to prepend
 * @param sessionId - Session ID for Langfuse observation
 * @returns The trimmed content of the first response message
 * @throws Error if the OpenAI API call fails
 */
export const openaiChatCompletionOriginal = wrapAI('gpt-4o', async ({
	messages,
	model = 'gpt-4o',
	temperature = 0.0,
	max_tokens = 256,
	systemPrompt = '',
	sessionId,
}: {
	messages: ChatCompletionMessageParam[];
	model?: string;
	temperature?: number;
	max_tokens?: number;
	systemPrompt?: string;
	sessionId?: string;
}) => {
	const openai = new OpenAI({ apiKey: process.env.NEXT_PUBLIC_OPENAI_API_KEY });
	const client = observeOpenAI(openai);
	const chatMessages: ChatCompletionMessageParam[] = systemPrompt
		? [{ role: 'system', content: systemPrompt } as ChatCompletionMessageParam, ...messages]
		: messages;
	try {
		const response = await client.chat.completions.create({
			model,
			messages: chatMessages,
			temperature,
			max_tokens,
			...(sessionId ? { observationOptions: { session: sessionId } } : {}),
		});
		const content = response.choices[0].message?.content?.trim() || '';
		return content;
	} catch (error: unknown) {
		throw new Error(
		typeof error === 'object' && error !== null && 'response' in error
			// @ts-expect-error: error shape from OpenAI SDK
			? error?.response?.data?.error?.message || 'OpenAI API error'
			: (error as Error).message || 'OpenAI API error'
		);
	}
}, { model: 'gpt-4o', provider: 'openai' });

/**
 * Calls the Anthropic Claude API via the Vercel AI SDK with the same
 * interface as openaiChatCompletionOriginal. Uses Claude Sonnet 4.5.
 *
 * @param messages - Array of chat messages
 * @param model - Model name (default: claude-sonnet-4-5-20250929)
 * @param temperature - Sampling temperature (default: 0.0)
 * @param max_tokens - Maximum tokens in response (default: 256)
 * @param systemPrompt - Optional system prompt to prepend
 * @param sessionId - Session ID (unused for Anthropic, kept for interface compatibility)
 * @returns The trimmed content of the response
 * @throws Error if the Anthropic API call fails
 */
export const anthropicChatCompletion = wrapAI('claude-sonnet-4-5', async ({
	messages,
	model = 'claude-sonnet-4-5-20250929',
	temperature = 0.0,
	max_tokens = 256,
	systemPrompt = '',
	sessionId: _sessionId,
}: {
	messages: ChatCompletionMessageParam[];
	model?: string;
	temperature?: number;
	max_tokens?: number;
	systemPrompt?: string;
	sessionId?: string;
}) => {
	void _sessionId; // kept for interface compatibility with openaiChatCompletion
	const apiKey = process.env.ANTHROPIC_API_KEY;
	if (!apiKey) {
		throw new Error('ANTHROPIC_API_KEY is not configured');
	}
	const provider = createAnthropic({ apiKey });
	const chatMessages = systemPrompt
		? [{ role: 'system' as const, content: systemPrompt }, ...messages.map(m => ({ role: m.role as 'user' | 'assistant' | 'system', content: typeof m.content === 'string' ? m.content : '' }))]
		: messages.map(m => ({ role: m.role as 'user' | 'assistant' | 'system', content: typeof m.content === 'string' ? m.content : '' }));

	try {
		const result = await generateText({
			model: provider(model),
			messages: chatMessages,
			temperature,
			maxOutputTokens: max_tokens,
		});
		return result.text.trim();
	} catch (error: unknown) {
		console.error('Error in anthropicChatCompletion:', error);
		throw new Error(
			error instanceof Error ? error.message : 'Anthropic API error'
		);
	}
}, { model: 'claude-sonnet-4-5-20250929', provider: 'anthropic' });

/**
 * Dispatches to openaiChatCompletionOriginal or anthropicChatCompletion
 * based on the AI_PROVIDER env var. Defaults to 'openai' if not set.
 */
export const openaiChatCompletion = process.env.AI_PROVIDER === 'anthropic'
	? anthropicChatCompletion
	: openaiChatCompletionOriginal;

// Agentic flow orchestration logic is now available for extension
