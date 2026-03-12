/**
 * utils/aiDataStream.ts
 *
 * Helpers for writing the Vercel AI SDK data stream wire protocol.
 * Each line is: `{hex_code}:{json_encoded_value}\n`
 *
 * Protocol codes:
 *   0  TEXT_DELTA         — one streamed text token
 *   2  DATA               — arbitrary data annotations (array)
 *   3  ERROR              — fatal error string
 *   e  FINISH_STEP        — end of a pipeline step with usage/reason
 *   d  FINISH_MESSAGE     — stream complete with final usage stats
 *   f  MESSAGE_START      — message ID emitted at stream open
 *
 * Usage:
 *   import { writeMessageStart, writeTextDelta, writeData, ... } from '@/utils/aiDataStream';
 *   writeData(controller, [{ type: 'status', message: 'Planning…' }]);
 *   writeTextDelta(controller, 'Hello ');
 *   writeFinishMessage(controller, { promptTokens: 10, completionTokens: 42 });
 */

const encoder = new TextEncoder();

/** Encodes a single protocol line and enqueues it onto the stream controller.
 * No-ops automatically if the controller does not support enqueue (e.g. non-streaming environment). */
function writeLine(controller: ReadableStreamDefaultController, code: string, value: unknown): void {
  if (typeof controller?.enqueue !== 'function') return;
  controller.enqueue(encoder.encode(`${code}:${JSON.stringify(value)}\n`));
}

// ---------------------------------------------------------------------------
// Public writers
// ---------------------------------------------------------------------------

/**
 * Emits the message-start line with a unique message ID.
 * Should be the very first line written to a new stream.
 *
 * Wire format: `f:[{"messageId":"<id>"}]\n`
 */
export function writeMessageStart(
  controller: ReadableStreamDefaultController,
  messageId: string,
): void {
  writeLine(controller, 'f', [{ messageId }]);
}

/**
 * Emits a single streamed text token.
 *
 * Wire format: `0:"<token>"\n`
 */
export function writeTextDelta(
  controller: ReadableStreamDefaultController,
  token: string,
): void {
  writeLine(controller, '0', token);
}

/**
 * Emits a data annotation array.  All custom events (status updates, plan
 * events, result events) are sent through this channel so consumers can
 * distinguish them by the `type` field inside each object.
 *
 * Wire format: `2:[{...}, ...]\n`
 *
 * @param items - Array of objects to annotate.  Each should have a `type` field.
 */
export function writeData(
  controller: ReadableStreamDefaultController,
  items: Record<string, unknown>[],
): void {
  writeLine(controller, '2', items);
}

/**
 * Emits a fatal error string and should be followed immediately by closing
 * the stream.
 *
 * Wire format: `3:"<message>"\n`
 */
export function writeError(
  controller: ReadableStreamDefaultController,
  message: string,
): void {
  writeLine(controller, '3', message);
}

/**
 * Emits a finish-step marker.  Call this at the end of each logical pipeline
 * phase (planning done, execution done, etc.) to let consumers track progress.
 *
 * Wire format: `e:{"finishReason":"<reason>","usage":{...},"isContinued":<bool>}\n`
 */
export function writeFinishStep(
  controller: ReadableStreamDefaultController,
  opts: {
    finishReason?: string;
    promptTokens?: number;
    completionTokens?: number;
    isContinued?: boolean;
  } = {},
): void {
  writeLine(controller, 'e', {
    finishReason: opts.finishReason ?? 'stop',
    usage: {
      promptTokens: opts.promptTokens ?? 0,
      completionTokens: opts.completionTokens ?? 0,
    },
    isContinued: opts.isContinued ?? false,
  });
}

/**
 * Emits the finish-message line with final aggregate usage stats and closes
 * the stream.  This must be the last line written.
 *
 * Wire format: `d:{"finishReason":"stop","usage":{...}}\n`
 */
export function writeFinishMessage(
  controller: ReadableStreamDefaultController,
  opts: { promptTokens?: number; completionTokens?: number } = {},
): void {
  writeLine(controller, 'd', {
    finishReason: 'stop',
    usage: {
      promptTokens: opts.promptTokens ?? 0,
      completionTokens: opts.completionTokens ?? 0,
    },
  });
  controller.close();
}

// ---------------------------------------------------------------------------
// Shorthand helpers for common data annotation types
// ---------------------------------------------------------------------------

/** Status/progress update (replaces the old `event: status` SSE event). */
export function writeStatus(
  controller: ReadableStreamDefaultController,
  message: string,
): void {
  writeData(controller, [{ type: 'status', message }]);
}

/** Plan-awaiting-approval event (replaces the old `event: plan` SSE event). */
export function writePlan(
  controller: ReadableStreamDefaultController,
  payload: {
    message: string;
    sessionId: string;
    awaitingApproval: boolean;
    refinedQuery?: string;
    planResponse?: string;
    executionPlan?: unknown[];
  },
): void {
  writeData(controller, [{ type: 'plan', ...payload }]);
}

/** Complete non-streaming result (replaces the old `event: result` SSE event). */
export function writeResult(
  controller: ReadableStreamDefaultController,
  payload: Record<string, unknown>,
): void {
  writeData(controller, [{ type: 'result', ...payload }]);
}

/**
 * Emitted once per tool/API call just before execution starts.
 * Lets the client display which endpoint or SQL query is being run in real time.
 *
 * Wire format: `2:[{"type":"tool_call","stepNumber":N,"description":"...","method":"POST","path":"/...","sql":"SELECT ..."}]\n`
 */
export function writeToolCall(
  controller: ReadableStreamDefaultController,
  payload: {
    stepNumber: number;
    description: string;
    method: string;
    path: string;
    sql?: string;
  },
): void {
  writeData(controller, [{ type: 'tool_call', ...payload }]);
}
