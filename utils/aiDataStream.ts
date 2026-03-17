/**
 * utils/aiDataStream.ts
 *
 * Helpers for writing Vercel AI SDK data-stream wire protocol frames to a
 * ReadableStreamDefaultController.
 *
 * Wire format reference (from the route header):
 *   f:{...}          — stream open / message start
 *   0:"<token>"      — text delta
 *   2:[{...}]        — generic data array (status, plan, result, tool_call)
 *   3:"<message>"    — fatal error
 *   e:{...}          — finish step
 *   d:{...}          — finish message (also closes the stream)
 */

const encoder = new TextEncoder();

/** Encodes and enqueues a single wire-protocol frame. No-op if the controller is already closed. */
function write(controller: ReadableStreamDefaultController, frame: string): void {
  try {
    controller.enqueue(encoder.encode(frame));
  } catch (err: unknown) {
    // Swallow "Controller is already closed" — this is expected when a write
    // races with a prior close (e.g. after finish() completes the stream).
    if (err instanceof Error && err.message.includes('Invalid state')) return;
    throw err;
  }
}

/** f:{messageId}\n — signals the start of a new message. */
export function writeMessageStart(
  controller: ReadableStreamDefaultController,
  messageId: string
): void {
  write(controller, `f:${JSON.stringify({ messageId })}\n`);
}

/** 0:"<token>"\n — streams one text delta token to the client. */
export function writeTextDelta(
  controller: ReadableStreamDefaultController,
  delta: string
): void {
  write(controller, `0:${JSON.stringify(delta)}\n`);
}

/** 2:[{type:"status", message}]\n — emits a progress status update. */
export function writeStatus(
  controller: ReadableStreamDefaultController,
  message: string
): void {
  write(controller, `2:${JSON.stringify([{ type: 'status', message }])}\n`);
}

export interface WritePlanData {
  message: string;
  sessionId: string;
  awaitingApproval: boolean;
  refinedQuery: string;
  planResponse: string;
  executionPlan: unknown[];
}

/** 2:[{type:"plan", ...}]\n — emits the actionable plan awaiting user approval. */
export function writePlan(
  controller: ReadableStreamDefaultController,
  data: WritePlanData
): void {
  write(controller, `2:${JSON.stringify([{ type: 'plan', ...data }])}\n`);
}

export interface WriteResultData {
  message: string;
  error?: string;
  [key: string]: unknown;
}

/** 2:[{type:"result", ...}]\n — emits a complete (non-streaming) final result. */
export function writeResult(
  controller: ReadableStreamDefaultController,
  data: WriteResultData
): void {
  write(controller, `2:${JSON.stringify([{ type: 'result', ...data }])}\n`);
}

/** 3:"<message>"\n — emits a fatal stream error. Does NOT close the controller. */
export function writeError(
  controller: ReadableStreamDefaultController,
  message: string
): void {
  write(controller, `3:${JSON.stringify(message)}\n`);
}

export interface FinishData {
  completionTokens: number;
}

/** e:{...}\n — emits the finish-step frame. */
export function writeFinishStep(
  controller: ReadableStreamDefaultController,
  data: FinishData
): void {
  write(
    controller,
    `e:${JSON.stringify({
      finishReason: 'stop',
      usage: { completionTokens: data.completionTokens },
      isContinued: false,
    })}\n`
  );
}

/**
 * d:{...}\n — emits the finish-message frame and closes the stream.
 * Must be the last frame written.
 */
export function writeFinishMessage(
  controller: ReadableStreamDefaultController,
  data: FinishData
): void {
  write(
    controller,
    `d:${JSON.stringify({
      finishReason: 'stop',
      usage: { completionTokens: data.completionTokens },
    })}\n`
  );
  try {
    controller.close();
  } catch (err: unknown) {
    if (err instanceof Error && err.message.includes('Invalid state')) return;
    throw err;
  }
}

/** 2:[{type:"tool_call", ...info}]\n — emits a tool-call progress event. */
export function writeToolCall(
  controller: ReadableStreamDefaultController,
  info: unknown
): void {
  write(
    controller,
    `2:${JSON.stringify([{ type: 'tool_call', ...(info as Record<string, unknown>) }])}\n`
  );
}
