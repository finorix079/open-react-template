/**
 * ed_workflows.ts
 *
 * ElasticDash workflow entry point.
 *
 * chatHandler uses HTTP mode: it calls the running Next.js dev server at
 * APP_URL/api/chat instead of importing the Next.js route handler directly.
 * This avoids NextRequest/NextResponse subprocess incompatibility.
 *
 * Startup order:
 *   1. npm run dev          — start the project (port 3001)
 *   2. npx elasticdash dashboard — start the dashboard (port 4573)
 */

const APP_URL = process.env.APP_URL ?? 'http://localhost:3001';

/**
 * Calls the live /api/chat endpoint on the running dev server.
 * Input must be JSON-serialisable; returns the parsed JSON response body.
 */
export const chatHandler = async (input: {
  messages: Array<{ role: string; content: string }>;
  sessionId?: string;
  isApproval?: boolean;
  [key: string]: unknown;
}): Promise<unknown> => {
  const response = await fetch(`${APP_URL}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`chatHandler HTTP ${response.status}: ${text}`);
  }

  return response.json();
};

export { chatStreamHandler } from './app/api/chat-stream/chatStreamHandler';
export type { ChatStreamResult, ChatStreamInput } from './app/api/chat-stream/chatStreamHandler';
