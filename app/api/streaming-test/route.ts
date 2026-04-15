/**
 * app/api/streaming-test/route.ts
 *
 * TEST-ONLY route — DO NOT deploy to production.
 *
 * Reproduces the streaming ALS failure described in .temp/feature_req.md.
 * Uses the BROKEN pattern: `initHttpRunContext(enterWith)` in the handler
 * scope, then returns a ReadableStream. Inside `start()`, ALS context is
 * lost because `enterWith` only affects the current async context — not the
 * new context created by ReadableStream.start().
 *
 * Failure modes exercised:
 *   1+2  — ALS context loss: wrapTool / wrapAI calls inside start() see null ALS
 *   3    — Module instance split: initHttpRunContext loaded here vs wrapTool in ed_tools.ts
 *          via separate eval('require') calls — potentially different ALS stores
 *   4+5  — wrapAI streaming incompatibility: streamText() returns ReadableStream,
 *          not Promise — wrapAI can't capture output or apply prompt mocks
 *
 * The snapshot .temp/snapshots/stream-3.json contains the expected trace
 * events when the SDK's global fallback is working correctly.
 */

import { NextRequest } from 'next/server';
import { streamText } from 'ai';
import { createAnthropic } from '@ai-sdk/anthropic';
import { searchPokemon } from '@/ed_tools';
import { edStartTrace } from '@/ed_workflows';
import {
  writeMessageStart,
  writeTextDelta,
  writeStatus,
  writeResult,
  writeError,
  writeFinishStep,
  writeFinishMessage,
} from '@/utils/aiDataStream';
import { randomUUID } from 'crypto';
import { startActiveObservation } from '@langfuse/tracing';
import type { LangfuseSpan, LangfuseTool } from '@langfuse/tracing';
import { WrapAIFn } from '@/utils/aiHandler';

// ---------------------------------------------------------------------------
// wrapAI — loaded via eval('require') to bypass Turbopack static analysis.
// Falls back to a passthrough stub if elasticdash-test is unavailable.
// NOTE: This is a SEPARATE eval('require') from the one in ed_tools.ts,
// which means it may resolve to a different module instance with its own ALS.
// This is Failure Mode 3 (module instance ALS split).
// ---------------------------------------------------------------------------
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let wrapAI: WrapAIFn = (_name: string, fn: any) => fn;
try {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  wrapAI = (eval('require') as (id: string) => any)('elasticdash-test').wrapAI ?? wrapAI;
} catch { /* elasticdash-test not available — passthrough stub remains active */ }

// ---------------------------------------------------------------------------
// wrapAI-wrapped NON-streaming Claude call (Failure Mode 1+2).
// When ALS is lost, wrapAI sees no context and skips telemetry.
// With the global fallback, it should still push the AI turn event.
// ---------------------------------------------------------------------------
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
            'You are a helpful assistant. Synthesise the data into a clear, concise one-line answer.',
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
  { model: 'claude-sonnet-4-5-20250929', provider: 'claude' },
);

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

/**
 * POST /api/streaming-test
 *
 * Accepts `{ messages: [{ role, content }] }` (same shape as chatStreamHandler)
 * and returns a Vercel AI SDK data stream.
 * Uses the BROKEN ALS pattern to reproduce the streaming context loss.
 */
export async function POST(request: NextRequest): Promise<Response> {
  const anthropicApiKey = process.env.ANTHROPIC_API_KEY ?? '';
  if (!anthropicApiKey) {
    return new Response(JSON.stringify({ error: 'ANTHROPIC_API_KEY not set' }), { status: 500 });
  }

  const body = await request.json();
  // Accept messages array (dashboard shape) or fall back to query string
  const messages: Array<{ role: string; content: string }> = body?.messages ?? [];
  const lastUserMessage = messages.filter((m: { role: string }) => m.role === 'user').pop();
  const query: string = lastUserMessage?.content ?? body?.query ?? 'Tell me about Pikachu';

  // --- Read ElasticDash headers ---
  const edRunId = request.headers.get('x-elasticdash-run-id');
  const edServer = request.headers.get('x-elasticdash-server');

  // --- BROKEN PATTERN: initHttpRunContext with enterWith in handler scope ---
  // This sets ALS context via enterWith() which only affects THIS async context.
  // When ReadableStream.start() runs, it creates a NEW async context where ALS is null.
  if (edRunId && edServer) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const { initHttpRunContext } = (eval('require') as (id: string) => any)('elasticdash-test');
      await initHttpRunContext(edRunId, edServer);
      // ALS is alive HERE — but will be dead inside start() below.
    } catch {
      // elasticdash-test not available — proceed without dashboard context
    }
  }

  const messageId = randomUUID();

  // --- Create stream and return Response immediately ---
  // The handler scope (where ALS was set) ends when we return.
  // start() runs in a detached async context where ALS is null.
  const stream = new ReadableStream({
    async start(controller) {
      await edStartTrace('streamingTest');
      await startActiveObservation('streamingTest', async (span: LangfuseSpan) => {
        let spanOutput: Record<string, unknown> = {};

        try {
          writeMessageStart(controller, messageId);
          writeStatus(controller, 'Searching Pokémon data…');

          // -----------------------------------------------------------------
          // Failure Mode 1+2+3: wrapTool call inside start()
          // searchPokemon is wrapTool-wrapped in ed_tools.ts.
          // ALS is null here → wrapTool sees no context → telemetry dropped.
          // With global fallback → wrapTool finds context → telemetry flows.
          // -----------------------------------------------------------------
          const pokemonName = query.toLowerCase().includes('pikachu') ? 'pikachu' : 'ditto';
          const toolInput = { searchterm: pokemonName };
          const toolObs: LangfuseTool = span.startObservation('searchPokemon', {
            input: toolInput,
          }, { asType: 'tool' });
          let pokemonData: unknown;
          try {
            pokemonData = await searchPokemon(toolInput);
            toolObs.update({ output: pokemonData });
            toolObs.end();
          } catch (err) {
            toolObs.update({ level: 'ERROR', statusMessage: (err as Error).message }).end();
            throw err;
          }

          writeStatus(controller, 'Generating answer…');

          // -----------------------------------------------------------------
          // Failure Mode 1+2: wrapAI non-streaming call inside start()
          // wrapAI wraps a function that returns Promise<T> — this works
          // structurally. But ALS is null → wrapAI sees no context →
          // AI turn event not pushed.
          // With global fallback → wrapAI finds context → event pushed.
          // -----------------------------------------------------------------
          const userContent = `Question: ${query}\n\nExecution result: ${JSON.stringify(pokemonData)}`;
          const aiObs = span.startObservation('claude-sonnet-final-answer', {
            input: { userContent },
            model: 'claude-sonnet-4-5-20250929',
          }, { asType: 'generation' });
          let text: string;
          let tokens: number;
          try {
            const result = await anthropicFinalAnswer({ userContent, apiKey: anthropicApiKey });
            text = result.text;
            tokens = result.tokens;
            aiObs.update({ output: { text, outputTokens: tokens } });
            aiObs.end();
          } catch (err) {
            aiObs.update({ level: 'ERROR', statusMessage: (err as Error).message }).end();
            throw err;
          }

          // -----------------------------------------------------------------
          // Failure Mode 4+5: direct streamText() call (NOT wrapAI-wrapped)
          // This demonstrates that wrapAI CANNOT wrap streaming responses.
          // streamText() returns a ReadableStream — wrapAI expects Promise<T>.
          // Even with the global fallback, there's no AI turn event for this
          // call because wrapAI was never applied.
          // Fix requires: pushTelemetryEvent(ctx, event) from the SDK.
          // -----------------------------------------------------------------
          const provider = createAnthropic({ apiKey: anthropicApiKey });
          const streamObs = span.startObservation('claude-sonnet-streaming-rewrite', {
            input: { text },
            model: 'claude-sonnet-4-5-20250929',
          }, { asType: 'generation' });
          const streamingResult = streamText({
            model: provider('claude-sonnet-4-5-20250929'),
            messages: [
              {
                role: 'system',
                content: 'Rewrite the following answer in a friendlier tone. Keep it to one paragraph.',
              },
              { role: 'user', content: text },
            ],
          });

          let streamedText = '';
          for await (const delta of streamingResult.textStream) {
            streamedText += delta;
            writeTextDelta(controller, delta);
          }
          const streamUsage = await streamingResult.usage;
          const totalTokens = tokens + (streamUsage?.outputTokens ?? 0);
          streamObs.update({ output: { text: streamedText, outputTokens: streamUsage?.outputTokens ?? 0 } });
          streamObs.end();

          spanOutput = { query, pokemonName, answer: streamedText, totalTokens };

          writeResult(controller, {
            message: streamedText,
            note: 'The wrapAI-wrapped call (non-streaming) should appear in the dashboard. '
              + 'The direct streamText() call (streaming) will NOT appear — this is Failure Mode 4+5.',
          });
          writeFinishStep(controller, { completionTokens: totalTokens });
          writeFinishMessage(controller, { completionTokens: totalTokens });
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : 'Internal server error';
          console.error('[streaming-test] Error:', err);
          spanOutput = { error: message };
          writeError(controller, message);
          try { controller.close(); } catch { /* already closed */ }
        } finally {
          span.update({ input: { query, messages }, output: spanOutput }).end();
        }
      }); // end startActiveObservation
    },
  });

  // Handler returns immediately — ALS scope created by initHttpRunContext ends here.
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/plain; charset=utf-8',
      'x-vercel-ai-data-stream': 'v1',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
    },
  });
}
