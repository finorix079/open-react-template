// --- Agentic Tool Definitions ---
// Watchlist service (to manage user watchlist entries)
import { watchlistAdd, watchlistRemove } from '@/services/watchlistService';
import OpenAI from 'openai';
import { appendLogLine } from '@/services/logger';
import { NodeSDK } from "@opentelemetry/sdk-node";
import { observeOpenAI } from "@langfuse/openai";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseObservation, LangfuseSpan, LangfuseTool } from "@langfuse/tracing";
import { startActiveObservation } from "@langfuse/tracing";
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { RequestContext } from '@/services/chatPlannerService';
import { apiService, dataService, pokemonService, queryRefinement, taskSelectorService, watchlistService } from '@/ed_tools';

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
	dataService: {
		name: "dataService",
		async execute(input: any, parentObs: LangfuseObservation): Promise<unknown> {
			return executeWithObservation(parentObs, "dataService", input, async () => {
				// const typedInput = input as { query: string };
				return await dataService(input);
			});
		},
		description: "Run SELECT queries on database",
	},
	pokemonService: {
		name: "pokemonService",
		async execute(input: any, parentObs: LangfuseObservation): Promise<unknown> {
			return executeWithObservation(parentObs, "pokemonService", input, async () => {
				return await pokemonService(input);
			});
		},
		description: "Search and manage Pokémon data",
	},
	taskSelectorService: {
		name: "taskSelectorService",
		async execute(input: any, parentObs: LangfuseObservation): Promise<unknown> {
			return executeWithObservation(parentObs, "taskSelectorService", input, async () => {
				const { queryEmbedding, topK, context } = input as { queryEmbedding: number[]; topK?: number; context?: unknown };
				return await taskSelectorService({ queryEmbedding, topK, context: context as (RequestContext | undefined) });
			});
		},
		description: "Find top-k similar API tasks",
	},
	watchlistService: {
		name: "watchlistService",
		async execute(input: any, parentObs: LangfuseObservation): Promise<unknown> {
			return executeWithObservation(parentObs, "watchlistService", input, async () => {
				const { action, payload, userToken } = input as { action: 'add' | 'remove' | 'list'; payload?: any; userToken?: string };
				if (action === 'add') return await watchlistAdd(payload, userToken);
				if (action === 'remove') return await watchlistRemove(payload, userToken);
				return await watchlistService(input);
			});
		},
		description: "Manage user Pokémon watchlist",
	},
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

const sdk = new NodeSDK({
    spanProcessors: [new LangfuseSpanProcessor()],
});
 
sdk.start();

export async function kimiChatCompletion({
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
}) {
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
		appendLogLine(`kimiChatCompletion - model=${model} messages=${chatMessages.length} tokens=${response.usage?.total_tokens ?? 'N/A'} status=success`);
		return content;
	} catch (error: unknown) {
		appendLogLine(`kimiChatCompletion - model=${model} status=error error=${typeof error === 'object' && error !== null ? (error as Error).message : String(error)}`);
		console.error('Error in kimiChatCompletion:', error);
		console.error('Related response: ', response);
		throw new Error(
		typeof error === 'object' && error !== null && 'response' in error
			// @ts-expect-error: error shape from OpenAI SDK
			? error?.response?.data?.error?.message || 'Kimi OpenAI API error'
			: (error as Error).message || 'Kimi OpenAI API error'
		);
	}
}

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
export async function openaiChatCompletionOriginal({
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
}) {
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
		appendLogLine(`openaiChatCompletion - model=${model} messages=${chatMessages.length} tokens=${response.usage?.total_tokens ?? 'N/A'} status=success`);
		return content;
	} catch (error: unknown) {
		appendLogLine(`openaiChatCompletion - model=${model} status=error error=${typeof error === 'object' && error !== null ? (error as Error).message : String(error)}`);
		throw new Error(
		typeof error === 'object' && error !== null && 'response' in error
			// @ts-expect-error: error shape from OpenAI SDK
			? error?.response?.data?.error?.message || 'OpenAI API error'
			: (error as Error).message || 'OpenAI API error'
		);
	}
}

export const openaiChatCompletion = openaiChatCompletionOriginal;

// Agentic flow orchestration logic is now available for extension
