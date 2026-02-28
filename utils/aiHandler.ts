import OpenAI from 'openai';
import { NodeSDK } from "@opentelemetry/sdk-node";
// import { observeOpenAI } from "@elasticdash/openai";
// import { ElasticDashSpanProcessor } from "@elasticdash/otel";
import { observeOpenAI } from "@langfuse/openai";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';


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

// export const openaiChatCompletion = observe(openaiChatCompletionOriginal, {
//   name: "OpenAI Chat Completion",
//   captureInput: true,
//   captureOutput: true,
// });

export const openaiChatCompletion = openaiChatCompletionOriginal;
