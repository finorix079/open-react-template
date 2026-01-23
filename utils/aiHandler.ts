import OpenAI from 'openai';
import { NodeSDK } from "@opentelemetry/sdk-node";
import { observeOpenAI } from "@langfuse/openai";
import { LangfuseSpanProcessor } from "@langfuse/otel";
import { observe } from '@elasticdash/tracing';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

const sdk = new NodeSDK({
  spanProcessors: [new LangfuseSpanProcessor()],
});
 
sdk.start();

/**
 * Calls the OpenAI Chat Completion API with the provided parameters.
 * Ensures type safety for message objects.
 *
 * @param apiKey - OpenAI API key
 * @param messages - Array of chat messages
 * @param model - Model name (default: gpt-4o)
 * @param temperature - Sampling temperature (default: 0.0)
 * @param max_tokens - Maximum tokens in response (default: 256)
 * @param systemPrompt - Optional system prompt to prepend
 * @returns The trimmed content of the first response message
 * @throws Error if the OpenAI API call fails
 */
export async function openaiChatCompletionOriginal({
	apiKey,
	messages,
	model = 'gpt-4o',
	temperature = 0.0,
	max_tokens = 256,
	systemPrompt = '',
} : {
	apiKey: string,
	messages: ChatCompletionMessageParam[];
	model?: string;
	temperature?: number;
	max_tokens?: number;
	systemPrompt?: string;
}) {
	const openai = new OpenAI({ apiKey });
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
		});
        const output = response.choices[0]?.message?.content?.trim() || '';
		return output;
	} catch (error: unknown) {
		if (typeof error === 'object' && error !== null && 'response' in error) {
			// @ts-expect-error: error shape from OpenAI SDK
			throw new Error(error?.response?.data?.error?.message || 'OpenAI API error');
		}
		throw new Error((error as Error).message || 'OpenAI API error');
	}
}

export const openaiChatCompletion = observe(openaiChatCompletionOriginal);
