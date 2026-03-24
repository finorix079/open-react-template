/**
 * app/api/chat-stream/chatStreamHandler.ts
 *
 * Testable wrapper around POST /api/chat-stream for the elasticdash framework.
 *
 * Uses HTTP mode: calls the running Next.js dev server via fetch instead of
 * importing the route handler directly. Start the project first before running
 * tests or the dashboard.
 *
 * Startup order:
 *   1. npm run dev          — start the project (port 3001)
 *   2. npx elasticdash dashboard — start the dashboard (port 4573)
 */

import { readVercelAIStream, recordToolCall } from 'elasticdash-test';
import type { VercelAIStreamResult } from 'elasticdash-test';
import type { Message } from '@/services/chatPlannerService';

const APP_URL = process.env.APP_URL ?? 'http://localhost:3001';

/**
 * `ChatStreamResult` is the structured return type of `chatStreamHandler`.
 * Aliased from `VercelAIStreamResult` so the test framework can record,
 * parse, and replay the Vercel AI SDK data-stream wire protocol automatically.
 */
export type ChatStreamResult = VercelAIStreamResult;

/**
 * Input type for `chatStreamHandler`.
 * Matches the shape the elasticdash test framework passes naturally:
 * `messages` and optional `sessionId` at the top level.
 */
export interface ChatStreamInput {
  messages: Message[];
  sessionId?: string;
  userToken?: string;
  testCaseId?: string;
  testCaseRunRecordId?: string;
}

/**
 * Inner implementation: calls the running dev server at APP_URL/api/chat-stream
 * via fetch, then parses the Vercel AI SDK data-stream response into a
 * structured `ChatStreamResult`.
 */
async function _chatStreamHandlerImpl({
  messages,
  sessionId,
  userToken = '',
  testCaseId,
  testCaseRunRecordId,
}: ChatStreamInput): Promise<ChatStreamResult> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (userToken) headers['Authorization'] = `Bearer ${userToken}`;
  if (testCaseId) headers['x-reset-test-case'] = testCaseId;
  if (testCaseRunRecordId) headers['x-reset-test-case-run-record'] = testCaseRunRecordId;

  const response = await fetch(`${APP_URL}/api/chat-stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ messages, ...(sessionId ? { sessionId } : {}) }),
  })
  .catch(err => {
    console.error('Network error calling chat-stream API:', err);
    return new Response(JSON.stringify({ error: err.message }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  });

  // The route returns a plain JSON error (no stream) when env vars are missing
  // or the request fails validation. Surface the message rather than returning
  // an empty result.
  if (response.headers.get('x-vercel-ai-data-stream') !== 'v1') {
    let errorMessage = `HTTP ${response.status}`;
    try {
      const json = await response.clone().json() as Record<string, unknown>;
      errorMessage = typeof json.error === 'string' ? json.error : JSON.stringify(json);
    } catch {
      errorMessage = await response.text().catch(() => errorMessage);
    }
    return { message: errorMessage, type: 'error', error: errorMessage };
  }

  return readVercelAIStream(response);
}

/**
 * Callable wrapper around POST /api/chat-stream for use as an elasticdash
 * workflow function. Calls the live dev server via fetch.
 *
 * `recordToolCall` is called manually after completion rather than via `wrapTool`.
 * This avoids the `wrapTool` deduplication flag that would suppress inner tool
 * recordings (queryRefinement, apiService, etc.) during the pipeline execution.
 * Inner tools self-record via `safeRecordToolCall` in `ed_tools.ts`.
 *
 * @param messages            - Conversation messages array.
 * @param sessionId           - Optional session ID for plan continuation.
 * @param userToken           - Bearer token forwarded as `Authorization` header.
 * @param testCaseId          - Optional test-case ID (forwarded as `x-reset-test-case`).
 * @param testCaseRunRecordId - Optional run-record ID (forwarded as `x-reset-test-case-run-record`).
 */
export async function chatStreamHandler(args: ChatStreamInput): Promise<ChatStreamResult> {
  const result = await _chatStreamHandlerImpl(args);
  recordToolCall('chatStream', args, result);
  return result;
}
