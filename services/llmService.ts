/**
 * llmService.ts
 *
 * Shared helper for calling Anthropic Claude Messages API.
 * Replaces all direct OpenAI chat completion fetch calls.
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';

export const CLAUDE_SONNET = 'claude-sonnet-4-20250514';
export const CLAUDE_HAIKU = 'claude-haiku-4-5-20251001';

/**
 * Calls the Anthropic Messages API.
 *
 * Accepts an OpenAI-style messages array (with optional system messages).
 * System messages are automatically extracted into the top-level `system` field.
 *
 * @returns The text content of the first response block.
 */
export async function callLLM({
  messages,
  apiKey,
  model = CLAUDE_SONNET,
  temperature = 0.5,
  maxTokens = 4096,
}: {
  messages: Array<{ role: string; content: string }>;
  apiKey: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
}): Promise<string> {
  const systemMessages = messages.filter((m) => m.role === 'system');
  let nonSystemMessages = messages.filter((m) => m.role !== 'system');

  // Anthropic requires at least one non-system message.
  // If only system messages were provided, move content to the system field
  // and add a minimal user prompt.
  if (nonSystemMessages.length === 0 && systemMessages.length > 0) {
    nonSystemMessages = [{ role: 'user', content: 'Please respond based on the instructions above.' }];
  }

  const body: Record<string, unknown> = {
    model,
    messages: nonSystemMessages,
    temperature,
    max_tokens: maxTokens,
  };

  if (systemMessages.length > 0) {
    body.system = systemMessages.map((m) => m.content).join('\n\n');
  }

  const response = await fetch(ANTHROPIC_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Anthropic API error ${response.status}: ${text}`);
  }

  const data = await response.json();
  return data.content?.[0]?.text ?? '';
}
