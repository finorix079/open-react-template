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
import { randomUUID } from 'crypto';
import { handleQueryConceptsAndNeeds } from '@/utils/queryRefinement';
import { plannerAgent } from '@/utils/aiHandler';
import { getAllMatchedApis, getTopKResults, Message, RequestContext } from '@/services/chatPlannerService';
import { pendingPlans, generateSessionId } from '../chat/session';
import { createSession, getSession, setApprovalStatus } from '@/services/conversationDb';
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
 *   - POST /general/sql/query whose body contains a SELECT statement
 * Everything else — POST/PUT/PATCH/DELETE to other endpoints, or a non-SELECT SQL — is a write.
 */
function isReadOnlyStep(step: ExecutionStep): boolean {
  const method = (step.api?.method ?? '').toLowerCase();
  if (method === 'get') return true;

  const path = step.api?.path ?? '';
  if (method === 'post' && path === '/general/sql/query') {
    const sql = (step.api?.requestBody?.query ?? '').trimStart().toUpperCase();
    return sql.startsWith('SELECT');
  }

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
 * Uses Anthropic Claude streaming to generate and emit the final answer as text-delta events.
 * The executor result and any useful data are passed as context.
 *
 * @param controller      - The ReadableStream controller to enqueue events onto.
 * @param executorMessage - The message produced by executeIterativePlanner.
 * @param refinedQuery    - The refined user query (used as system context).
 * @param anthropicApiKey - Anthropic API key.
 * @param usefulData      - Optional serialised useful-data string from the request context.
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
): Promise<number> {
  const provider = createAnthropic({ apiKey: anthropicApiKey });

  const userContent = usefulData
    ? `Question: ${refinedQuery}\n\nData collected:\n${usefulData}\n\nExecution result: ${executorMessage}`
    : `Question: ${refinedQuery}\n\nExecution result: ${executorMessage}`;

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

  for await (const delta of textStream) {
    writeTextDelta(controller, delta);
  }

  if (executedStepsSummary) {
    writeTextDelta(controller, `\n\n---\n\n${executedStepsSummary}`);
  }

  const { outputTokens } = await usage;
  return outputTokens ?? 0;
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
  } catch {
    return new Response(JSON.stringify({ error: 'Invalid JSON body' }), {
      status: 400,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  const parsed = ChatStreamRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return new Response(
      JSON.stringify({ error: parsed.error.message }),
      { status: 400, headers: { 'Content-Type': 'application/json' } },
    );
  }

  const authHeader = request.headers.get('Authorization') || '';
  const userToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';

  const { messages, sessionId: clientSessionId } = parsed.data as {
    messages: Message[];
    sessionId?: string;
  };

  const messageId = randomUUID();

  const stream = new ReadableStream({
    async start(controller) {
      /** Emit finish-step + finish-message and close the stream. */
      const finish = (tokens = 0) => {
        writeFinishStep(controller, { completionTokens: tokens });
        writeFinishMessage(controller, { completionTokens: tokens });
        // writeFinishMessage already calls controller.close()
      };

      try {
        writeMessageStart(controller, messageId);

        if (!Array.isArray(messages) || messages.length === 0) {
          writeError(controller, 'messages array is required');
          controller.close();
          return;
        }

        const sessionId = (clientSessionId as string | undefined) || generateSessionId(messages);

        const userMessage = [...messages].reverse().find((msg: Message) => msg.role === 'user');

        // -----------------------------------------------------------------------
        // Guard: if this session already has a pending plan being waited on,
        // do not re-run the planning pipeline. The SSE stream that emitted the
        // plan is still open and polling for the approval decision via the DB.
        // -----------------------------------------------------------------------
        if (pendingPlans.has(sessionId)) {
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
            writeResult(controller, { message: String(reason) });
            finish();
            return;
          }
          throw err;
        }

        if (actionablePlan.impossible) {
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
          const allReadOnly = steps.every(isReadOnlyStep);

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
            );

            if (result.error) {
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
            const tokens = await streamFinalAnswer(
              controller,
              result.message ?? JSON.stringify(result.accumulatedResults ?? []),
              refinedQuery,
              anthropicApiKey,
              undefined,
              readOnlyStepsSummary,
            );
            finish(tokens);
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
          const POLL_INTERVAL_MS = 2_000;
          const MAX_WAIT_MS = 5 * 60 * 1_000; // 5 minutes
          const pollStart = Date.now();

          writeStatus(controller, 'Waiting for your approval…');

          while (Date.now() - pollStart < MAX_WAIT_MS) {
            await new Promise<void>((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));

            const session = getSession(sessionId);
            const decision = session?.status;

            if (decision === 'approved') {
              // Consume the decision so a late duplicate click is a no-op
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
              );

              if (result.error) {
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
              const tokens = await streamFinalAnswer(
                controller,
                result.message ?? JSON.stringify(result.accumulatedResults ?? []),
                planEntry.refinedQuery,
                anthropicApiKey,
                undefined,
                approvedStepsSummary,
              );
              finish(tokens);
              return;
            }

            if (decision === 'rejected') {
              setApprovalStatus(sessionId, 'completed');
              pendingPlans.delete(sessionId);
              writeResult(controller, {
                message: 'Plan rejected. Please tell me what you would like to change, or ask a new question.',
                planRejected: true,
              });
              finish();
              return;
            }
          }

          // Timed out waiting for approval
          pendingPlans.delete(sessionId);
          writeResult(controller, {
            message: 'Approval timed out after 5 minutes. Please resend your message to try again.',
            planRejected: true,
          });
          finish();
          return;
        }

        // --- No execution steps — generate answer directly ---
        if (
          actionablePlan.message &&
          typeof actionablePlan.message === 'string' &&
          actionablePlan.message.toLowerCase().includes('goal completed')
        ) {
          writeStatus(controller, 'Generating answer…');
          const tokens = await streamFinalAnswer(controller, '', refinedQuery, anthropicApiKey, usefulDataStr);
          finish(tokens);
          return;
        }

        writeResult(controller, { message: 'Plan does not include an execution plan.' });
        finish();
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : 'Internal server error';
        console.error('[chat-stream] Unhandled error:', err);
        writeError(controller, message);
        controller.close();
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
