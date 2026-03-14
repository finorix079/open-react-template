/**
 * app/api/chat-stream/chatStreamHandler.ts
 *
 * Testable wrapper around POST /api/chat-stream for the elasticdash framework.
 *
 * THIS FILE IS INTENTIONALLY SEPARATE FROM route.ts.
 * It imports `elasticdash-test` (a worker-only package) and must never be
 * imported by route.ts or any other file that Next.js bundles. It is only
 * imported by ed_workflows.ts, which the elasticdash CLI loads in a
 * subprocess where the package is available.
 *
 * See docs/elasticdash-next-import-guide.md for the full explanation.
 */

import { NextRequest } from 'next/server';
import { readVercelAIStream, recordToolCall } from 'elasticdash-test';
import type { VercelAIStreamResult } from 'elasticdash-test';
import type { Message } from '@/services/chatPlannerService';
import { POST } from './route';

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
 * Inner implementation: constructs a NextRequest and calls the POST handler
 * directly (no HTTP server required), then parses the Vercel AI SDK data-stream
 * response into a structured `ChatStreamResult`.
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

  const req = new NextRequest('http://localhost/api/chat-stream', {
    method: 'POST',
    headers,
    body: JSON.stringify({ messages, ...(sessionId ? { sessionId } : {}) }),
  });

  const response = await POST(req);

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
 * workflow function. Calls the route directly without requiring a running
 * HTTP server.
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
