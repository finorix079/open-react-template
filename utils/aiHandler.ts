// --- Agentic Tool Definitions ---
import { dynamicApiRequest } from '@/services/apiService';
import { clarifyAndRefineUserInput } from '@/utils/queryRefinement';
import { runSelectQuery } from '@/services/dataService';
import { searchPokemon } from '@/services/pokemonService';
import { findTopKSimilarApi } from '@/services/taskSelectorService';
// Watchlist service (to manage user watchlist entries)
import { watchlistAdd, watchlistRemove, watchlistList } from '@/services/watchlistService';
import OpenAI from 'openai';
import { NodeSDK } from "@opentelemetry/sdk-node";
import { observeOpenAI } from "@langfuse/openai";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { LangfuseObservation, LangfuseSpan, LangfuseTool } from "@langfuse/tracing";
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';
import { RequestContext } from '@/services/chatPlannerService';

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
				const typedInput = input as { baseUrl: string; schema: any; userToken?: string };
				return await dynamicApiRequest(typedInput.baseUrl, typedInput.schema, typedInput.userToken);
			});
		},
		description: "Dynamic API request tool",
	},
	queryRefinement: {
		name: "queryRefinement",
		async execute(input: any, parentObs: LangfuseObservation): Promise<unknown> {
			return executeWithObservation(parentObs, "queryRefinement", input, async () => {
				const typedInput = input as { userInput: string; userToken?: string };
				return await clarifyAndRefineUserInput(typedInput.userInput, typedInput.userToken);
			});
		},
		description: "Refine and clarify user queries",
	},
	dataService: {
		name: "dataService",
		async execute(input: any, parentObs: LangfuseObservation): Promise<unknown> {
			return executeWithObservation(parentObs, "dataService", input, async () => {
				const typedInput = input as { query: string };
				return await runSelectQuery(typedInput.query);
			});
		},
		description: "Run SELECT queries on database",
	},
	pokemonService: {
		name: "pokemonService",
		async execute(input: any, parentObs: LangfuseObservation): Promise<unknown> {
			return executeWithObservation(parentObs, "pokemonService", input, async () => {
				return await searchPokemon(input);
			});
		},
		description: "Search and manage Pokémon data",
	},
	taskSelectorService: {
		name: "taskSelectorService",
		async execute(input: any, parentObs: LangfuseObservation): Promise<unknown> {
			const { queryEmbedding, topK, context } = input as { queryEmbedding: number[]; topK?: number; context?: unknown };
			return executeWithObservation(parentObs, "taskSelectorService", input, async () => {
				return await findTopKSimilarApi({ queryEmbedding, topK, context: context as (RequestContext | undefined) });
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
				return await watchlistList(userToken);
			});
		},
		description: "Manage user Pokémon watchlist",
	},
};

// --- Named Agent Example ---
/**
 * Planning Agent: Responsible for generating and refining plans.
 * Shares tool set but only uses planning-related tools.
 */
export const planningAgent: Agent = {
	id: "planning-agent-001",
	name: "PlanningAgent",
	plan: {
		goal: "Generate and refine execution plans",
		tasks: [],
	},
	selectTool: (task) => {
		// For planning, use queryRefinement or other planning tools
		if (task.tool && task.tool.name && agentTools[task.tool.name]) {
			return agentTools[task.tool.name];
		}
		throw new Error(`No planning tool found for task: ${JSON.stringify(task)}`);
	},
	executeTask: async (task: AgentTask, parentObs: LangfuseObservation): Promise<AgentTask> => {
		const tool = agentTools[task.tool.name];
		const input = task.input;
		try {
			task.output = await tool.execute(input, parentObs);
			task.status = "completed";
		} catch (err) {
			task.status = "failed";
			task.output = {
				error: err instanceof Error ? err.message : String(err),
				stack: err instanceof Error ? err.stack : undefined,
			};
		}
		return task;
	},
	run: async function (rootSpan: LangfuseSpan): Promise<AgentPlan> {
		let apiCallCount = 0;
		const API_CALL_LIMIT = 50;
		try {
			for (const task of this.plan.tasks) {
				if (apiCallCount >= API_CALL_LIMIT) {
					rootSpan.update({
						statusMessage: `API call limit (${API_CALL_LIMIT}) reached`,
						level: 'ERROR',
						output: this.plan
					});
					rootSpan.end();
					break;
				}
				await this.executeTask(task, rootSpan);
				apiCallCount++;
			}
			if (apiCallCount < API_CALL_LIMIT) {
				rootSpan.update({ output: this.plan });
				rootSpan.end();
			}
			return this.plan;
		} catch (err) {
			rootSpan.update({
				statusMessage: (err as Error).message,
				level: 'ERROR',
				output: this.plan
			});
			rootSpan.end();
			throw err;
		}
	},
};

/**
 * Executor Agent: Responsible for executing plan steps.
 * Shares tool set but only uses execution-related tools.
 */
export const executorAgent: Agent = {
	id: "executor-agent-001",
	name: "ExecutorAgent",
	plan: {
		goal: "Execute plan steps using available tools",
		tasks: [],
	},
	selectTool: (task) => {
		// For execution, use apiService, dataService, etc.
		if (task.tool && task.tool.name && agentTools[task.tool.name]) {
			return agentTools[task.tool.name];
		}
		throw new Error(`No execution tool found for task: ${JSON.stringify(task)}`);
	},
	executeTask: async (task: AgentTask, parentObs: LangfuseObservation): Promise<AgentTask> => {
		const tool = agentTools[task.tool.name];
		const input = task.input;
		try {
			task.output = await tool.execute(input, parentObs);
			task.status = "completed";
		} catch (err) {
			task.status = "failed";
			task.output = {
				error: err instanceof Error ? err.message : String(err),
				stack: err instanceof Error ? err.stack : undefined,
			};
		}
		return task;
	},
	run: async function (rootSpan: LangfuseSpan): Promise<AgentPlan> {
		let apiCallCount = 0;
		const API_CALL_LIMIT = 50;
		console.log(`ExecutorAgent starting execution of plan with ${this.plan.tasks.length} tasks`);
		try {
			for (const task of this.plan.tasks) {
				if (apiCallCount >= API_CALL_LIMIT) {
					rootSpan.update({
						statusMessage: `API call limit (${API_CALL_LIMIT}) reached`,
						level: 'ERROR',
						output: this.plan
					});
					rootSpan.end();
					break;
				}
				await this.executeTask(task, rootSpan);
				console.log(`ExecutorAgent completed task ${task.id} with status ${task.status}`);
				apiCallCount++;
			}
			if (apiCallCount < API_CALL_LIMIT) {
				rootSpan.update({ output: this.plan });
				console.log('ExecutorAgent completed all tasks within API call limit');
				rootSpan.end();
			}
			return this.plan;
		} catch (err) {
			rootSpan.update({
				statusMessage: (err as Error).message,
				level: 'ERROR',
				output: this.plan
			});
			rootSpan.end();
			throw err;
		}
	},
};

/**
 * Agentic flow interfaces and stub orchestration logic
 * Custom agentic flow implementation for tool-based automation
 *
 * Extend Agent, AgentTask, AgentTool, AgentPlan for new agentic flows
 */
export interface AgentTask {
  id: string;
  description: string;
  tool: AgentTool;
  input: any;
  output?: unknown;
  status: "pending" | "in-progress" | "completed" | "failed";
}

export interface AgentPlan {
  tasks: AgentTask[];
  goal: string;
}

export interface Agent {
  id: string;
  name: string;
  plan: AgentPlan;
  selectTool: (task: AgentTask) => AgentTool;
  executeTask: (task: AgentTask, parentObs: LangfuseObservation) => Promise<AgentTask>;
  run: (rootSpan: LangfuseSpan) => Promise<AgentPlan>;
}

/**
 * Example stub agentic flow entry point
 * Extend this function for custom agentic orchestration
 */
export async function runAgenticFlow(rootSpan: LangfuseSpan, plan: AgentPlan): Promise<AgentPlan> {
  // Iterate through tasks, select tools, execute, and update status
  for (const task of plan.tasks) {
    task.status = "in-progress";
    try {
      const tool = task.tool;
      task.output = await tool.execute(task.input, rootSpan);
      task.status = "completed";
    } catch (err) {
      task.status = "failed";
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
	try {
		const response = await client.chat.completions.create({
			model,
			messages: chatMessages,
			temperature,
			max_tokens,
			...(sessionId ? { observationOptions: { session: sessionId } } : {}),
		});
		// Return the full response for tracing
		return response.choices[0].message?.content?.trim() || '';
	} catch (error: unknown) {
		throw new Error(
		typeof error === 'object' && error !== null && 'response' in error
			// @ts-expect-error: error shape from OpenAI SDK
			? error?.response?.data?.error?.message || 'OpenAI API error'
			: (error as Error).message || 'OpenAI API error'
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
		// Return the full response for tracing
		return response.choices[0].message?.content?.trim() || '';
	} catch (error: unknown) {
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
