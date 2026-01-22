import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions';

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
export async function openaiChatCompletion({
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
	const chatMessages: ChatCompletionMessageParam[] = systemPrompt
		? [{ role: 'system', content: systemPrompt } as ChatCompletionMessageParam, ...messages]
		: messages;
	try {
		const response = await openai.chat.completions.create({
			model,
			messages: chatMessages,
			temperature,
			max_tokens,
		});
		return response.choices[0]?.message?.content?.trim() || '';
	} catch (error: unknown) {
		if (typeof error === 'object' && error !== null && 'response' in error) {
			// @ts-expect-error: error shape from OpenAI SDK
			throw new Error(error?.response?.data?.error?.message || 'OpenAI API error');
		}
		throw new Error((error as Error).message || 'OpenAI API error');
	}
}
