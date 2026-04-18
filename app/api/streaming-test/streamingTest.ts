/**
 * app/api/streaming-test/streamingTest.ts
 *
 * Testable wrapper around POST /api/streaming-test for the elasticdash framework.
 *
 * Uses HTTP mode: the dashboard calls the route directly via elasticdash.config.ts
 * (which injects ED headers). This file provides the matching export name so the
 * dashboard discovers the workflow.
 *
 * Startup order:
 *   1. npm run dev              — start the project (port 3001)
 *   2. npx elasticdash dashboard — start the dashboard (port 4573)
 */

import { readVercelAIStream, recordToolCall } from 'elasticdash-test/http';
import type { VercelAIStreamResult } from 'elasticdash-test/http';

const APP_URL = process.env.APP_URL ?? 'http://localhost:3001';

/** Structured return type aliased from the SDK's stream parser. */
export type StreamingTestResult = VercelAIStreamResult;

/** Input type matching the dashboard's natural shape. */
export interface StreamingTestInput {
  messages: Array<{ role: string; content: string }>;
}

/**
 * Calls the running dev server at APP_URL/api/streaming-test via fetch,
 * then parses the Vercel AI SDK data-stream response.
 */
async function _streamingTestImpl({
  messages,
}: StreamingTestInput): Promise<StreamingTestResult> {
  const response = await fetch(`${APP_URL}/api/streaming-test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ messages }),
  }).catch(err => {
    console.error('Network error calling streaming-test API:', err);
    return new Response(JSON.stringify({ error: err.message }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  });

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
 * Callable wrapper around POST /api/streaming-test for use as an elasticdash
 * workflow function. Name matches the workflow key in elasticdash.config.ts
 * so the dashboard uses HTTP mode (with ED headers injected).
 */
export async function streamingTest(args: StreamingTestInput): Promise<StreamingTestResult> {
  const result = await _streamingTestImpl(args);
  recordToolCall('streamingTest', args, result);
  return result;
}
