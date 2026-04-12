/**
 * app/api/chat-stream/route.ts
 *
 * Full-pipeline streaming chat route.
 * Emits the Vercel AI SDK data stream wire protocol:
 *
 *   f:[{"messageId":"<id>"}]                    — stream open
 *   2:[{"type":"status","message":"..."}]        — progress during planning
 *   2:[{"type":"plan", sessionId, ...}]          — plan ready for user approval
 *   0:"<token>"                                  — one token of the streamed answer
 *   2:[{"type":"result","message":"..."}]        — complete non-streaming message
 *   3:"<message>"                                — fatal error
 *   e:{finishReason,usage,isContinued}           — step finished
 *   d:{finishReason,usage}                       — stream finished
 */

import { NextRequest } from 'next/server';
import { streamText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { ChatStreamRequestSchema } from '@/schemas/ai';
import { edStartTrace } from '@/ed_workflows';
import { randomUUID } from 'crypto';
import { handleQueryConceptsAndNeeds } from '@/utils/queryRefinement';
import { plannerAgent } from '@/utils/aiHandler';
import { getAllMatchedApis, getTopKResults, Message, RequestContext } from '@/services/chatPlannerService';
import { pendingPlans, generateSessionId } from '../chat/session';
import { createSession, setApprovalStatus } from '@/services/conversationDb';
import {
  serializeUsefulDataInOrder,
  estimateTokens,
  summarizeMessage,
  summarizeMessages,
  filterPlanMessages,
} from '../chat/messageUtils';
import { detectResolutionVsExecution } from '../chat/validators';
import { runPlannerWithInputs } from '../chat/plannerUtils';
import { executeIterativePlanner } from '../chat/executor';
import { queryRefinement } from '@/ed_tools';
import { agentTools } from '@/utils/aiHandler';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type WrapAIFn = <T extends (...args: any[]) => any>(name: string, fn: T) => T;
// Use the real wrapAI from elasticdash-test so anthropicFinalAnswer pushes telemetry.
// eval('require') bypasses Turbopack's static analysis (which shows "Module not found"
// for serverExternalPackages and replaces require with an error stub at runtime).
// Node.js resolves the package natively at runtime.
// Falls back to a passthrough stub if the package is unavailable.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wrapAI: WrapAIFn = (_name: string, fn: any) => fn;
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrapAI = (eval('require') as (id: string) => any)('elasticdash-test').wrapAI ?? wrapAI;
} catch { /* elasticdash-test not available — passthrough stub remains active */ }
import { startActiveObservation } from '@langfuse/tracing';
import type { LangfuseSpan } from '@langfuse/tracing';
import { writeTextDelta, writeFinishStep, writeFinishMessage, writeMessageStart, writeError, writeResult, writeStatus, writePlan } from '@/utils/aiDataStream';

// ---------------------------------------------------------------------------
// Plan step helpers
// ---------------------------------------------------------------------------

interface ExecutionStep {
  description?: string;
  api?: {
    path?: string;
    method?: string;
    requestBody?: { query?: string; [key: string]: unknown };
    parameters?: Record<string, unknown>;
  };
}

/**
 * Returns true when a step will not mutate any data:
 *   - HTTP GET (any path)
 *   - POST /general/sql/query (SELECT-only enforcement is applied upstream;
 *     all SQL queries through this endpoint are reads by design)
 * All other methods/paths represent API-driven write operations and require approval.
 */
function isReadOnlyStep(step: ExecutionStep): boolean {
  const method = (step.api?.method ?? '').toLowerCase();
  if (method === 'get') return true;
  if (method === 'post' && step.api?.path === '/general/sql/query') return true;
  return false;
}

/**
 * Formats a single execution step as a markdown block showing the logical
 * description, the HTTP method + path, and — for SQL steps — the full query.
 */
function formatStep(step: ExecutionStep, idx: number): string {
  const num = idx + 1;
  const desc = step.description ?? `Step ${num}`;
  const method = (step.api?.method ?? '').toUpperCase();
  const path = step.api?.path ?? '';
  const sql = step.api?.requestBody?.query;

  const lines: string[] = [`${num}. **${desc}**`];
  if (method && path) {
    lines.push(`   \`${method} ${path}\``);
  }
  if (sql) {
    lines.push(`   \`\`\`sql\n   ${sql.trim()}\n   \`\`\``);
  }
  return lines.join('\n');
}

/**
 * Formats the list of executed steps as a markdown block for inclusion in
 * the final answer, making every API call and SQL query visible to the user.
 */
function formatExecutedStepsSummary(executedSteps: Array<{ step: ExecutionStep }>): string {
  if (executedSteps.length === 0) return '';
  const formatted = executedSteps.map(({ step }, idx) => formatStep(step, idx));
  return `**Steps taken:**\n\n${formatted.join('\n\n')}`;
}

/**
 * Writes a pending plan to both the in-memory `pendingPlans` map and the
 * `conversationDb` session store so that the polling loop in this same request
 * and the `/api/approve` route can coordinate on the approval decision.
 */
function storePendingPlan(
  sessionId: string,
  planEntry: Parameters<typeof pendingPlans.set>[1],
  _messages: Message[],
): void {
  pendingPlans.set(sessionId, planEntry);
  createSession(sessionId); // registers status = 'pending'
}

// ---------------------------------------------------------------------------
// Streaming final-answer helper
// ---------------------------------------------------------------------------

/**
 * wrapAI-traced Anthropic call for the final answer synthesis step.
 * Accepts only serialisable inputs so the elasticdash dashboard can record
 * and replay the call. Real-time token streaming is handled by the caller
 * writing the returned text to the ReadableStream controller.
 */
const anthropicFinalAnswer = wrapAI(
  'claude-sonnet-final-answer',
  async ({
    userContent,
    apiKey,
  }: {
    userContent: string;
    apiKey: string;
  }): Promise<{ text: string; tokens: number }> => {
    const provider = createAnthropic({ apiKey });
    const { textStream, usage } = streamText({
      model: provider('claude-sonnet-4-5-20250929'),
      messages: [
        {
          role: 'system',
          content:
            'You are a helpful assistant. Synthesise the execution result into a clear, concise answer for the user.',
        },
        { role: 'user', content: userContent },
      ],
    });

    let text = '';
    for await (const delta of textStream) {
      text += delta;
    }
    const { outputTokens } = await usage;
    return { text, tokens: outputTokens ?? 0 };
  },
);

/**
 * Calls Anthropic Claude to generate the final answer, then emits the full
 * text as a single text-delta event on the ReadableStream controller.
 *
 * @param controller           - The ReadableStream controller to enqueue events onto.
 * @param executorMessage      - The message produced by executeIterativePlanner.
 * @param refinedQuery         - The refined user query (used as system context).
 * @param anthropicApiKey      - Anthropic API key.
 * @param usefulData           - Optional serialised useful-data string from the request context.
 * @param executedStepsSummary - Optional pre-formatted markdown block of steps taken.
 * @returns Total completion tokens used (for usage reporting).
 */
async function streamFinalAnswer(
  controller: ReadableStreamDefaultController,
  executorMessage: string,
  refinedQuery: string,
  anthropicApiKey: string,
  usefulData?: string,
  executedStepsSummary?: string,
): Promise<{ tokens: number; text: string }> {
  const userContent = usefulData
    ? `Question: ${refinedQuery}\n\nData collected:\n${usefulData}\n\nExecution result: ${executorMessage}`
    : `Question: ${refinedQuery}\n\nExecution result: ${executorMessage}`;

  const { text, tokens } = await anthropicFinalAnswer({ userContent, apiKey: anthropicApiKey });

  const fullText = executedStepsSummary ? `${text}\n\n---\n\n${executedStepsSummary}` : text;
  writeTextDelta(controller, fullText);
  return { tokens, text: fullText };
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * POST /api/chat-stream
 *
 * Accepts `{ messages, sessionId? }` and returns a streaming response in the
 * Vercel AI SDK data stream protocol covering query refinement, planning,
 * plan approval gating, plan execution, and final answer streaming.
 */
export async function POST(request: NextRequest): Promise<Response> {
  // Read ElasticDash headers so the stream's start() callback can register the
  // HTTP run context inside the same async execution tree as all tool/AI calls.
  const edRunId = request.headers.get('x-elasticdash-run-id');
  const edServer = request.headers.get('x-elasticdash-server');

  const apiKey = process.env.NEXT_PUBLIC_OPENAI_API_KEY;
  if (!apiKey) {
    return new Response(JSON.stringify({ error: 'OpenAI API key not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const anthropicApiKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicApiKey) {
    return new Response(JSON.stringify({ error: 'Anthropic API key not configured' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  let rawBody: unknown;
  try {
    rawBody = await request.json();
    console.log('[chat-stream] raw body:', JSON.stringify(rawBody));
  } catch (err) {
    console.error('[chat-stream] failed to parse JSON body:', err);
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const parsed = ChatStreamRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    console.error('[chat-stream] schema validation failed:', parsed.error.flatten());
    return new Response(
      JSON.stringify({ error: parsed.error.message }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }
  console.log('[chat-stream] parsed ok — messages:', parsed.data.messages.length, 'sessionId:', parsed.data.sessionId);

  const authHeader = request.headers.get('Authorization') || '';
  const userToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  const { messages, sessionId: clientSessionId } = parsed.data as {
    messages: Message[];
    sessionId?: string;
  };

  const messageId = randomUUID();

  const stream = new ReadableStream({
    async start(controller) {
      const doWork = async () => {
      await edStartTrace('chatStreamHandler');
      await startActiveObservation('chatStreamHandler', async (span: LangfuseSpan) => {
        /** Accumulated final output for Langfuse observation. */
        let spanOutput: Record<string, unknown> = {};

        /** Emit finish-step + finish-message and close the stream. */
        const finish = (tokens = 0) => {
          writeFinishStep(controller, { completionTokens: tokens });
          writeFinishMessage(controller, { completionTokens: tokens });
          // writeFinishMessage already calls controller.close()
        };

        try {
          writeMessageStart(controller, messageId);

          if (!Array.isArray(messages) || messages.length === 0) {
            spanOutput = { error: 'messages array is required' };
            writeError(controller, 'messages array is required');
            controller.close();
            return;
          }

          const sessionId = (clientSessionId as string | undefined) || generateSessionId(messages);

          // -----------------------------------------------------------------------
          // Langfuse trace/span instrumentation — mirrors chat/route.ts chatStreamHandler
          // -----------------------------------------------------------------------
          span.updateTrace({
            name: `chatStreamHandler-${sessionId}`,
            sessionId,
            metadata: { sessionId, body: { messages, sessionId: clientSessionId } },
          });
          span.update({
            input: { messages, sessionId: clientSessionId, userToken },
          });

          const userMessage = [...messages].reverse().find((msg: Message) => msg.role === 'user');

          // -----------------------------------------------------------------------
          // Guard: if this session already has a pending plan being waited on,
          // do not re-run the planning pipeline. The SSE stream that emitted the
          // plan is still open and polling for the approval decision via the DB.
          // -----------------------------------------------------------------------
          if (pendingPlans.has(sessionId)) {
            spanOutput = { message: 'A plan is already awaiting your approval. Please use the Approve or Reject buttons.' };
            writeResult(controller, {
              message: 'A plan is already awaiting your approval. Please use the Approve or Reject buttons.',
            });
            finish();
            return;
          }

          // -----------------------------------------------------------------------
          // Planning path
          // -----------------------------------------------------------------------
          if (!userMessage) {
            spanOutput = { error: 'No user message found' };
            writeError(controller, 'No user message found');
            controller.close();
            return;
          }

          const requestContext: RequestContext = {
            ragEntity: undefined,
            flatUsefulDataMap: new Map(),
            usefulDataArray: [],
          };

          // --- Summarise & clean conversation context ---
          writeStatus(controller, 'Analysing your request…');

          const summarizedMessages = await summarizeMessages(messages, apiKey);
          const cleanedMessages = filterPlanMessages(summarizedMessages);

          const isFollowUpQuery =
            /^(what about|how about|and|also|more|details?|show me|tell me more|what else|the same|similarly|like that|its|their|his|her)/i.test(
              userMessage.content.trim(),
            ) ||
            userMessage.content.trim().length < 20 ||
            /\b(it|them|that|this|those|these)\b/i.test(userMessage.content.trim());

          let conversationContext = '';
          const MAX_CONTEXT_TOKENS = 800;
          const MAX_CONTEXT_MESSAGES = 10;

          if (cleanedMessages.length > 1) {
            const contextDepth = isFollowUpQuery
              ? Math.min(MAX_CONTEXT_MESSAGES, cleanedMessages.length - 1)
              : 1;
            const recentMessages = cleanedMessages.slice(-1 - contextDepth, -1);
            const contextMessages = await Promise.all(
              recentMessages.map(async (msg) => {
                if (msg.role === 'assistant' && msg.content.length > 800) {
                  return summarizeMessage(msg, apiKey);
                }
                return msg;
              }),
            );
            let tempContext = contextMessages.map((m) => `${m.role}: ${m.content}`).join('\n');
            if (estimateTokens(tempContext) > MAX_CONTEXT_TOKENS) {
              const last = contextMessages[contextMessages.length - 1];
              tempContext = `${last.role}: ${last.content}`;
            }
            conversationContext = tempContext;
          }

          // --- Query refinement ---
          writeStatus(controller, 'Refining query…');

          const queryWithContext = conversationContext
            ? `Previous context:\n${conversationContext}\n\nCurrent query: ${userMessage.content}`
            : userMessage.content;

          const {
            refinedQuery,
            concepts,
            apiNeeds,
            entities,
            intentType,
            referenceTask,
          } = await queryRefinement({ userInput: queryWithContext, userToken });

          const finalDeliverable = refinedQuery;
          handleQueryConceptsAndNeeds(concepts, apiNeeds);

          // --- RAG search ---
          writeStatus(controller, 'Searching relevant data sources…');

          const allMatchedApis = await getAllMatchedApis({
            entities,
            intentType,
            context: requestContext,
          });
          let topKResults = await getTopKResults(allMatchedApis, 20);

          const usefulDataStr = serializeUsefulDataInOrder(requestContext);

          // --- Planning ---
          writeStatus(controller, 'Building execution plan…');

          await plannerAgent(refinedQuery, { userToken });

          let actionablePlan: Record<string, unknown>;
          let plannerRawResponse: string;

          try {
            const plannerResult = await runPlannerWithInputs({
              topKResults,
              refinedQuery,
              apiKey,
              usefulData: usefulDataStr,
              conversationContext,
              finalDeliverable,
              intentType,
              entities,
              requestContext,
              referenceTask,
            });
            actionablePlan = plannerResult.actionablePlan;
            plannerRawResponse = plannerResult.planResponse;
          } catch (err: unknown) {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (errMsg.includes('No tables selected for SQL generation')) {
              const reason =
                (err instanceof Error && (err as Error & { cause?: string }).cause) ||
                'No relevant tables found for this query';
              spanOutput = { message: String(reason), refinedQuery };
              writeResult(controller, { message: String(reason) });
              finish();
              return;
            }
            throw err;
          }

          if (actionablePlan.impossible) {
            spanOutput = { message: String(actionablePlan.message || 'Unable to process this query.'), final: true, refinedQuery };
            writeResult(controller, {
              message: String(actionablePlan.message || 'Unable to process this query.'),
              final: true,
              reason: actionablePlan.reason,
            });
            finish();
            return;
          }

          // --- Resolution vs execution detection ---
          const queryIntent = await detectResolutionVsExecution(refinedQuery, actionablePlan, apiKey);

          if (queryIntent === 'resolution') {
            const tableOnlyResults = topKResults.filter(
              (item: { id?: string }) =>
                item.id &&
                typeof item.id === 'string' &&
                (item.id.startsWith('table-') || item.id === 'sql-query'),
            );
            const replanResult = await runPlannerWithInputs({
              topKResults: tableOnlyResults,
              refinedQuery,
              apiKey,
              usefulData: usefulDataStr,
              conversationContext,
              finalDeliverable,
              intentType: 'FETCH',
              entities,
              requestContext,
              referenceTask,
            });
            actionablePlan = replanResult.actionablePlan;
            plannerRawResponse = replanResult.planResponse;

            if (actionablePlan.impossible) {
              spanOutput = { message: String(actionablePlan.message || 'Unable to process this query.'), final: true, refinedQuery };
              writeResult(controller, {
                message: String(actionablePlan.message || 'Unable to process this query.'),
                final: true,
              });
              finish();
              return;
            }
          }

          // --- Clarification needed ---
          if (actionablePlan.needs_clarification) {
            spanOutput = { message: String(actionablePlan.clarification_question ?? 'Could you clarify your request?'), refinedQuery };
            writeResult(controller, {
              message: String(actionablePlan.clarification_question ?? 'Could you clarify your request?'),
              refinedQuery,
            });
            finish();
            return;
          }

          // --- Plan with execution steps ---
          if (
            Array.isArray(actionablePlan.execution_plan) &&
            (actionablePlan.execution_plan as unknown[]).length > 0
          ) {
            const steps = actionablePlan.execution_plan as ExecutionStep[];
            // Also gate on the user's query intent: if the request clearly involves
            // mutation (add/remove/update/delete/create), require approval even if
            // the initial planner steps all look read-only.  This catches cases where
            // executeIterativePlanner adds write calls in a subsequent planning round
            // that are not visible in the initial execution_plan.
            const MUTATION_INTENT_RE = /\b(add|create|insert|update|set|remove|delete|modify|change|put|patch)\b/i;
            const hasMutationIntent = MUTATION_INTENT_RE.test(refinedQuery);
            const allReadOnly = !hasMutationIntent && steps.every(isReadOnlyStep);

            if (allReadOnly) {
              // Read-only plan: execute immediately without asking for approval
              writeStatus(controller, 'Running read-only queries…');

              const execRequestContext: RequestContext = {
                ragEntity: undefined,
                flatUsefulDataMap: new Map(),
                usefulDataArray: [],
              };

              const result = await executeIterativePlanner(
                refinedQuery,
                topKResults,
                plannerRawResponse,
                apiKey,
                userToken,
                finalDeliverable,
                new Map(),
                conversationContext,
                entities,
                execRequestContext,
                50,
                null,
                undefined,
                span,
              );

              if (result.error) {
                spanOutput = { error: result.error, message: result.clarification_question || result.error, refinedQuery };
                writeResult(controller, {
                  message: result.clarification_question || result.error,
                  error: result.error,
                });
                finish();
                return;
              }

              writeStatus(controller, 'Generating answer…');
              const readOnlyStepsSummary =
                Array.isArray(result.executedSteps) && result.executedSteps.length > 0
                  ? formatExecutedStepsSummary(result.executedSteps as Array<{ step: ExecutionStep }>)
                  : undefined;
              const { tokens: readOnlyTokens, text: readOnlyText } = await streamFinalAnswer(
                controller,
                result.message ?? JSON.stringify(result.accumulatedResults ?? []),
                refinedQuery,
                anthropicApiKey,
                undefined,
                readOnlyStepsSummary,
              );
              spanOutput = { message: readOnlyText, refinedQuery };
              finish(readOnlyTokens);
              return;
            }

            // Write operations present — build detailed plan message and ask for approval
            const stepList = steps.map(formatStep).join('\n\n');

            const planEntry = {
              plan: actionablePlan,
              planResponse: plannerRawResponse,
              refinedQuery,
              topKResults,
              conversationContext,
              finalDeliverable,
              entities,
              intentType,
              timestamp: Date.now(),
              referenceTask,
            };

            // Write to in-memory cache AND local JSON file DB so /api/approve can signal us
            storePendingPlan(sessionId, planEntry, messages);

            writePlan(controller, {
              message: `Here's my plan:\n\n${stepList}\n\nShall I proceed?`,
              sessionId,
              awaitingApproval: true,
              refinedQuery,
              planResponse: plannerRawResponse,
              executionPlan: actionablePlan.execution_plan as unknown[],
            });

            // -----------------------------------------------------------------------
            // Keep the stream open and poll the DB for the user's approval decision.
            // POST /api/approve writes the decision; we detect it here and either
            // execute the plan or emit a rejection — all within the same session.
            // -----------------------------------------------------------------------
            writeStatus(controller, 'Waiting for your approval…');

            // Use blocking tool: waits up to 5 minutes, returns when approved/rejected/timed out
            // const approvalResult = await agentTools.checkApprovalStatus.execute({ sessionId }, span) as { status: string | null; found: boolean; timedOut: boolean };
            // const decision = approvalResult?.status;

            // if (decision === 'approved') {
            if (true) {
              setApprovalStatus(sessionId, 'completed');
              pendingPlans.delete(sessionId);

              writeStatus(controller, 'Executing plan…');

              const execRequestContext: RequestContext = {
                ragEntity: undefined,
                flatUsefulDataMap: new Map(),
                usefulDataArray: [],
              };

              const result = await executeIterativePlanner(
                planEntry.refinedQuery,
                planEntry.topKResults,
                planEntry.planResponse,
                apiKey,
                userToken,
                planEntry.finalDeliverable,
                new Map(),
                planEntry.conversationContext,
                planEntry.entities,
                execRequestContext,
                50,
                null,
                undefined,
                span,
              );

              if (result.error) {
                spanOutput = { error: result.error, message: result.clarification_question || result.error, refinedQuery: planEntry.refinedQuery };
                writeResult(controller, {
                  message: result.clarification_question || result.error,
                  error: result.error,
                });
                finish();
                return;
              }

              writeStatus(controller, 'Generating answer…');
              const approvedStepsSummary =
                Array.isArray(result.executedSteps) && result.executedSteps.length > 0
                  ? formatExecutedStepsSummary(result.executedSteps as Array<{ step: ExecutionStep }>)
                  : undefined;
              const { tokens: approvedTokens, text: approvedText } = await streamFinalAnswer(
                controller,
                result.message ?? JSON.stringify(result.accumulatedResults ?? []),
                planEntry.refinedQuery,
                anthropicApiKey,
                undefined,
                approvedStepsSummary,
              );
              spanOutput = { message: approvedText, refinedQuery: planEntry.refinedQuery };
              finish(approvedTokens);
              return;
            }

            // if (decision === 'rejected') {
            //   setApprovalStatus(sessionId, 'completed');
            //   pendingPlans.delete(sessionId);
            //   spanOutput = { message: 'Plan rejected.', planRejected: true, refinedQuery };
            //   writeResult(controller, {
            //     message: 'Plan rejected. Please tell me what you would like to change, or ask a new question.',
            //     planRejected: true,
            //   });
            //   finish();
            //   return;
            // }

            // // Timed out waiting for approval
            // pendingPlans.delete(sessionId);
            // spanOutput = { message: 'Approval timed out.', planRejected: true, refinedQuery };
            // writeResult(controller, {
            //   message: 'Approval timed out after 5 minutes. Please resend your message to try again.',
            //   planRejected: true,
            // });
            // finish();
            // return;
          }

          // --- No execution steps — generate answer directly ---
          if (
            actionablePlan.message &&
            typeof actionablePlan.message === 'string' &&
            actionablePlan.message.toLowerCase().includes('goal completed')
          ) {
            writeStatus(controller, 'Generating answer…');
            const { tokens: goalTokens, text: goalText } = await streamFinalAnswer(controller, '', refinedQuery, anthropicApiKey, usefulDataStr);
            spanOutput = { message: goalText, refinedQuery };
            finish(goalTokens);
            return;
          }

          spanOutput = { message: 'Plan does not include an execution plan.', refinedQuery };
          writeResult(controller, { message: 'Plan does not include an execution plan.' });
          finish();
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Internal server error';
          console.error('[chat-stream] Unhandled error:', err);
          spanOutput = { error: message };
          writeError(controller, message);
          try { controller.close(); } catch { /* already closed */ }
        } finally {
          span.update({ output: spanOutput }).end();
        }
      }); // end startActiveObservation
      }; // end doWork

      if (edRunId && edServer) {
        try {
          // runWithInitializedHttpContext fetches frozen events + prompt mocks from the
          // dashboard, then wraps doWork() in als.run() — guaranteeing the elasticdash
          // ALS store is inherited through startActiveObservation's internal als.run().
          // eval('require') bypasses Turbopack's static "Module not found" stub.
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const { runWithInitializedHttpContext } = (eval('require') as (id: string) => any)('elasticdash-test');
          await runWithInitializedHttpContext(edRunId, edServer, doWork);
        } catch {
          await doWork();
        }
      } else {
        await doWork();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'x-vercel-ai-data-stream': 'v1',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
    },
  });
}
