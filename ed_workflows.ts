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

// The elasticdash-test module must be loaded via eval('require') to share
// the same CJS module instance as wrapTool/wrapAI (loaded in ed_tools.ts
// and route files). Using import() creates a separate ESM instance with
// separate ALS stores, causing tool events to be invisible to startTrace.
//
// eval('require') fails at Turbopack module-init time (__filename undefined),
// so we store a module reference that can be set from code that CAN require.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _ed: any = null;

/**
 * Set the elasticdash-test module reference. Call this from a file where
 * eval('require')('elasticdash-test') succeeds (e.g. ed_tools.ts).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function setElasticDashModule(mod: any): void {
  _ed = mod;
  console.log(`[ed_workflows] setElasticDashModule called, startTrace=${typeof mod?.startTrace}`);
}

/**
 * Ensures the observability context is initialised, then tags all subsequent
 * elasticdash telemetry events with the given workflow name.
 *
 * `tryAutoInitHttpContext` must run first — without it `startTrace` throws
 * because `getObservabilityContext()` returns undefined (the interceptors
 * that normally trigger auto-init haven't fired yet at handler entry).
 */
export const edStartTrace = async (workflowName: string): Promise<void> => {
  if (!_ed) { console.warn(`[ed_workflows] edStartTrace: _ed is null, skipping`); return; }
  try {
    await _ed.tryAutoInitHttpContext();
    _ed.startTrace(workflowName);
  } catch (err) {
    console.error(`[ed_workflows] edStartTrace error:`, err);
  }
};

/**
 * Ends the current trace. Call this when the workflow handler finishes
 * (e.g. in a finally block after span.end()). This flushes any pending
 * trace capture to disk when ELASTICDASH_CAPTURE_TRACE=1 is set.
 */
export const edEndTrace = (): void => {
  if (!_ed) return;
  try {
    _ed.endTrace();
  } catch (err) {
    console.error(`[ed_workflows] edEndTrace error:`, err);
  }
};

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

/**
 * HTTP-mode chatStreamHandler for use in ed_tests and CI.
 * Calls the running dev server at APP_URL/api/chat-stream via fetch,
 * avoiding direct imports with @/ path aliases that fail outside Next.js.
 */
export const chatStreamHandler = async (input: {
  messages: Array<{ role: string; content: string }>;
  sessionId?: string;
  userToken?: string;
  [key: string]: unknown;
}): Promise<unknown> => {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (input.userToken) headers['Authorization'] = `Bearer ${input.userToken}`;

  const response = await fetch(`${APP_URL}/api/chat-stream`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      messages: input.messages,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`chatStreamHandler HTTP ${response.status}: ${text}`);
  }

  // Return the raw response text since the stream format varies
  return response.text();
};

export { streamingTest } from './app/api/streaming-test/streamingTest';
export type { StreamingTestResult, StreamingTestInput } from './app/api/streaming-test/streamingTest';
