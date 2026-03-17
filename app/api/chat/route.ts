/**
 * route.ts
 * Next.js API route handler for the chat endpoint.
 * Business logic is delegated to the modules in this directory.
 */
import { NextRequest, NextResponse } from 'next/server';
import { handleQueryConceptsAndNeeds } from '@/utils/queryRefinement';
import { openaiChatCompletion, serializeAgentState, resumeAgentFromTrace, plannerAgent, executorAgent, AgentPlan, AgentState } from '@/utils/aiHandler';
import { getAllMatchedApis, getTopKResults, Message, RequestContext } from '@/services/chatPlannerService';
import { LangfuseSpan, propagateAttributes, startActiveObservation } from "@langfuse/tracing";
import { writeFileSync } from 'fs';
import { resolve } from 'path';

// Session management
import { pendingPlans, generateSessionId } from './session';

// Message utilities
import {
  serializeUsefulDataInOrder,
  estimateTokens,
  summarizeMessage,
  summarizeMessages,
  filterPlanMessages,
} from './messageUtils';

// Validators
import { detectResolutionVsExecution } from './validators';

// Planner utilities
import { runPlannerWithInputs } from './plannerUtils';

// Executor
import { generateFinalAnswer, executeIterativePlanner } from './executor';
import { queryRefinement } from '@/ed_tools';

const chatHandlerWrapper = async (request: NextRequest) => {
  // Create request-local context to prevent race conditions

  let testCaseId = request.headers.get('x-reset-test-case') || '';
  let testCaseRunRecordId = request.headers.get('x-reset-test-case-run-record') || '';
  let oauthToken = request.headers.get('Authorization') || '';
  console.log('Test Case ID:', testCaseId);
  console.log('Test Case Run Record ID:', testCaseRunRecordId);
  console.log('OAuth Token:', oauthToken);

  // Helper to log only this message to a file in the root folder
  function logTestCaseHeadersToRoot(headers: Headers) {
    const logPath = resolve(process.cwd(), 'debug_chat_request_headers.log');
    const logMsg = `\n\n${new Date().toISOString()}\nHeaders: ${JSON.stringify(Object.fromEntries(headers.entries()), null, 2)}`;
    writeFileSync(logPath, logMsg, { flag: 'a' });
  }

  logTestCaseHeadersToRoot(request.headers);

  let requestBody: any = null;
  try {
    let rawBody: string | undefined;
    // Check if request.body is a ReadableStream
    if (request.body && typeof request.body.getReader === 'function') {
      rawBody = await request.text();
    } else if (typeof request.body === 'string') {
      rawBody = request.body;
    } else if (typeof request.body === 'object' && request.body !== null) {
      // If body is already parsed (rare, but possible in some environments)
      requestBody = request.body;
    }
    if (rawBody !== undefined) {
      if (!rawBody || rawBody.trim().length === 0) {
        console.error('Request body is empty:', rawBody);
        return NextResponse.json({ error: 'Empty request body' }, { status: 400 });
      }
      requestBody = JSON.parse(rawBody);
    }
    if (!requestBody || typeof requestBody !== 'object') {
      console.error('Request body is not a valid object:', requestBody);
      return NextResponse.json({ error: 'Invalid JSON object in request body' }, { status: 400 });
    }
  } catch (err) {
    console.error('Failed to parse request body as JSON:', err);
    return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 });
  }

  // Extract user token from Authorization header (optional)
  const authHeader = request.headers.get('Authorization') || '';
  const userToken = authHeader.startsWith('Bearer ') ? authHeader.replace('Bearer ', '') : '';
  // console.log('userToken:', userToken);

  console.log('request: ', request);

  return chatHandler({ requestBody, userToken, testCaseId, testCaseRunRecordId })
  .then((output) => NextResponse.json(output))
  .catch((err) => {
      console.error('Error in chatHandler:', err);
      const output = {
        error: 'Internal server error'
      }
      // parent?.updateTrace({ output }); --- IGNORE ---
      return NextResponse.json(output, { status: 500 });
  });
};

export async function chatHandler(
  {
    requestBody, 
    testCaseId, 
    testCaseRunRecordId,
    userToken = '',
  }: {
    requestBody: any, 
    testCaseId?: string, 
    testCaseRunRecordId?: string,
    userToken: string
  }): Promise<any> {

  console.log('chatHandler invoked with requestBody:', requestBody);

  let output: any = null;
  let usefulData = new Map();
  let finalDeliverable = '';
  const requestContext: RequestContext = {
    ragEntity: undefined,
    flatUsefulDataMap: new Map(),
    usefulDataArray: []
  };
  return startActiveObservation("chatHandler", async (span: LangfuseSpan) => {
    const { messages, sessionId: clientSessionId, isApproval: clientIsApproval } = requestBody;
    const sessionId = clientSessionId || generateSessionId(messages);

    span.updateTrace({
      name: "chatHandler-" + sessionId, // Use client session ID if provided for better trace correlation
    })
    span.update({
      input: {
        requestBody, 
        testCaseId, 
        testCaseRunRecordId,
        userToken
      },
    });

    span.updateTrace({ 
      sessionId: sessionId,
      metadata: { 
        sessionId: sessionId, 
        testCaseId, 
        testCaseRunRecordId,
        body: requestBody
      }
    });

    try {
      console.log('\n💬 Received messages:', messages.length);
      console.log('\n💬 Received final message:', messages[messages.length - 1]);
      console.log('process.env.NEXT_PUBLIC_POKEMON_API:', process.env.NEXT_PUBLIC_POKEMON_API);

      // ------------------------------------------------------------------
      // Agent Mid-Trace Replay: if the request carries a serialised
      // AgentState, resume from the specified task index instead of running
      // the full pipeline.
      // ------------------------------------------------------------------
      if (requestBody.agentState && typeof requestBody.resumeFromTaskIndex === 'number') {
        console.log('🔁 Mid-trace replay requested from task index:', requestBody.resumeFromTaskIndex);
        const incomingState: AgentState = {
          ...requestBody.agentState,
          resumeFromTaskIndex: requestBody.resumeFromTaskIndex,
        };
        const resumedPlan = await resumeAgentFromTrace(incomingState);
        const replayAgentState = serializeAgentState(resumedPlan);
        output = {
          message: `Resumed from task ${requestBody.resumeFromTaskIndex}`,
          agentState: replayAgentState,
          executedTasks: resumedPlan.tasks,
          planStatus: resumedPlan.status,
        };
        return output;
      }

      // Use client-provided session ID if available, otherwise generate one
      console.log('📋 Session ID:', sessionId);
      console.log('📋 Client provided sessionId:', clientSessionId);
      console.log('📋 Pending plans:', Array.from(pendingPlans.keys()));

      // Propagate sessionId to all child observations
      await propagateAttributes(
        {
          sessionId: sessionId,
        },
        async () => {
          // All observations created here automatically have sessionId
          // ... your logic ...

          // Check if user is approving a pending plan
          const userMessage = [...messages].reverse().find((msg: Message) => msg.role === 'user');
          const userInput = userMessage?.content?.trim().toLowerCase() || '';
          const isApproval = clientIsApproval === true || /^(approve|yes|proceed|ok|confirm|go ahead)$/i.test(userInput);
          
          console.log('🔍 User input:', userInput);
          console.log('🔍 Is approval:', isApproval);
          console.log('🔍 Has pending plan:', pendingPlans.has(sessionId));
          
          if (isApproval && pendingPlans.has(sessionId)) {
            console.log('✅ User approved pending plan, proceeding with execution...');
            
            const pendingData = pendingPlans.get(sessionId)!;
            pendingPlans.delete(sessionId); // Remove from pending
            
            const apiKey = process.env.NEXT_PUBLIC_OPENAI_API_KEY;
            if (!apiKey) {
              return NextResponse.json(
                { error: 'OpenAI API key not configured' },
                { status: 500 }
              );
            }

            // Execute the approved plan
            if (pendingData.plan.execution_plan && pendingData.plan.execution_plan.length > 0) {
              console.log('▶️ Executing approved plan...');
              
              const result = await executeIterativePlanner(
                pendingData.refinedQuery,
                pendingData.topKResults,
                pendingData.planResponse,
                apiKey,
                userToken,
                pendingData.finalDeliverable,
                usefulData,
                pendingData.conversationContext,
                pendingData.entities,
                requestContext
              );

              // Sanitize and return result
              const sanitizeForResponse = (obj: any): any => {
                const seen = new WeakSet();
                return JSON.parse(JSON.stringify(obj, (key, value) => {
                  if (typeof value === 'object' && value !== null) {
                    if (seen.has(value)) return '[Circular]';
                    seen.add(value);
                    if (key === 'request' || key === 'socket' || key === 'agent' || key === 'res') return '[Omitted]';
                    if (key === 'config') return { method: value.method, url: value.url, data: value.data };
                    if (key === 'headers' && value.constructor?.name === 'AxiosHeaders') {
                      return Object.fromEntries(Object.entries(value));
                    }
                  }
                  return value;
                }));
              };

              if (result.error) {
                output = {
                  message: result.clarification_question || result.error,
                  error: result.error,
                  reason: result.reason,
                  refinedQuery: pendingData.refinedQuery,
                  topKResults: pendingData.topKResults,
                  executedSteps: sanitizeForResponse(result.executedSteps || []),
                  accumulatedResults: sanitizeForResponse(result.accumulatedResults || []),
                };
                return output;
              }

              output = {
                message: result.message,
                refinedQuery: pendingData.refinedQuery,
                topKResults: pendingData.topKResults,
                executedSteps: sanitizeForResponse(result.executedSteps),
                accumulatedResults: sanitizeForResponse(result.accumulatedResults),
                iterations: result.iterations,
              };
              return output;
            }
          }

          // Check if user is rejecting a pending plan
          const isRejection = userMessage && pendingPlans.has(sessionId) && !isApproval;
          if (isRejection) {
            console.log('❌ User rejected plan, clearing pending plan...');
            pendingPlans.delete(sessionId);
            
            output = {
              message: 'Plan rejected. Please tell me what you would like to change, or ask a new question.',
              planRejected: true,
            };
            return output;
          }

          if (!messages || !Array.isArray(messages)) {
            output = { error: 'Invalid messages format' };
            return NextResponse.json(
              output,
              { status: 400 }
            );
          }

          const apiKey = process.env.NEXT_PUBLIC_OPENAI_API_KEY;
          if (!apiKey) {
            output = { error: 'OpenAI API key not configured' };
            return NextResponse.json(
              output,
              { status: 500 }
            );
          }

          // userMessage already extracted above for approval check
          if (!userMessage) {
            output = { error: 'No user message found' };
            return NextResponse.json(
              output,
              { status: 400 }
            );
          }

          // Summarize conversation history for context (if messages > 10)
          const summarizedMessages = await summarizeMessages(messages, apiKey);
          
          // Filter out plan-related messages (plans, approvals, rejections)
          // Keep only user intentions and final results
          const cleanedMessages = filterPlanMessages(summarizedMessages);
          console.log(`📊 Context cleaning: ${summarizedMessages.length} messages → ${cleanedMessages.length} messages after filtering plans`);

          // Detect if this is a follow-up query or an independent query
          const isFollowUpQuery = /^(what about|how about|and|also|more|details?|show me|tell me more|what else|the same|similarly|like that|its|their|his|her)/i.test(userMessage.content.trim()) ||
            userMessage.content.trim().length < 20 || // Very short queries likely need context
            /\b(it|them|that|this|those|these)\b/i.test(userMessage.content.trim()); // Pronoun references

          // Build conversation context for query refinement
          // Include recent conversation history to maintain context continuity
          // IMPORTANT: Limit context to prevent historical information from overshadowing current intent
          let conversationContext = '';
          const MAX_CONTEXT_TOKENS = 800; // Hard limit on context size (~3200 characters)
          const MAX_CONTEXT_MESSAGES = 10; // Limit to last 3 CLEANED messages max (planning messages already filtered out)
          
          if (cleanedMessages.length > 1) {
            // For follow-up queries: include more context (last 2-3 exchanges)
            // For independent queries: include just previous message for potential reference
            // Note: cleanedMessages already has plan-related messages removed, so we're selecting from cleaned history
            const contextDepth = isFollowUpQuery ? Math.min(MAX_CONTEXT_MESSAGES, cleanedMessages.length - 1) : 1;
            const recentMessages = cleanedMessages.slice(-1 - contextDepth, -1);
            
            // Additional summarization for context if messages are still too long
            // This ensures we preserve critical data while reducing tokens
            const contextMessages = await Promise.all(
              recentMessages.map(async (msg) => {
                // Only summarize long assistant responses for context
                if (msg.role === 'assistant' && msg.content.length > 800) {
                  const summarized = await summarizeMessage(msg, apiKey);
                  return summarized;
                }
                return msg;
              })
            );
            
            let tempContext = contextMessages
              .map((msg) => `${msg.role}: ${msg.content}`)
              .join('\n');
            
            // Enforce token limit on context
            const contextTokens = estimateTokens(tempContext);
            if (contextTokens > MAX_CONTEXT_TOKENS) {
              // If context is too large, truncate older messages and keep only the most recent
              const recentMsg = contextMessages[contextMessages.length - 1];
              tempContext = `${recentMsg.role}: ${recentMsg.content}`;
              console.log(`⚠️ Context truncated: ${contextTokens} → ${estimateTokens(tempContext)} tokens to stay within limit`);
            }
            
            conversationContext = tempContext;
          }

          console.log(`🔍 Query type: ${isFollowUpQuery ? 'FOLLOW-UP (with extended context)' : 'INDEPENDENT (with minimal context)'}`);
          if (conversationContext) {
            const ctxTokens = estimateTokens(conversationContext);
            const msgCount = conversationContext.split('\n').filter(line => line.match(/^(user|assistant):/)).length;
            console.log(`📝 Using context (${msgCount} cleaned messages, ~${ctxTokens}/${MAX_CONTEXT_TOKENS} tokens, ${(ctxTokens/MAX_CONTEXT_TOKENS*100).toFixed(0)}% of limit):`);
            console.log(conversationContext.substring(0, 200) + (conversationContext.length > 200 ? '...' : ''));
          }

          // Clarify and refine user input WITH conversation context (only for follow-ups)
          const queryWithContext = conversationContext
            ? `Previous context:\n${conversationContext}\n\nCurrent query: ${userMessage.content}`
            : userMessage.content;

          const { refinedQuery, language, concepts, apiNeeds, entities, intentType, referenceTask } = await queryRefinement({
            userInput: queryWithContext, 
            userToken
          });
          // 设置原始finalDeliverable为refinedQuery，保证不被中间依赖覆盖
          if (!finalDeliverable) finalDeliverable = refinedQuery;
          console.log('\n📝 QUERY REFINEMENT RESULTS:');
          console.log('  Original:', userMessage.content);
          console.log('  Refined Query:', refinedQuery);
          console.log('  Language:', language);
          console.log('  Concepts:', concepts);
          console.log('  API Needs:', apiNeeds);
          console.log('  Extracted Entities:', entities);
          console.log('  Entity Count:', entities.length);

          // Handle concepts and API needs
          const { requiredApis, skippedApis } = handleQueryConceptsAndNeeds(concepts, apiNeeds);
          console.log('Required APIs:', requiredApis);
          console.log('Skipped APIs:', skippedApis);

          // Multi-entity RAG: Generate embeddings for each entity and combine results
          console.log(`\n🔍 Performing multi-entity RAG search for ${entities.length} entities`);


          // 获取所有实体的匹配API（embedding检索+过滤）
          const allMatchedApis = await getAllMatchedApis({ entities, intentType, context: requestContext });

          // Convert Map to array and sort by similarity
          let topKResults = await getTopKResults(allMatchedApis, 20);

          // Serialize useful data in chronological order (earliest first)
          const str = serializeUsefulDataInOrder(requestContext);

          // --- Planning Phase ---
          const planningStart = Date.now();
          let actionablePlan;
          let plannerRawResponse;

          // Use plannerAgent for planning trace (records a queryRefinement step for observability)
          await plannerAgent(refinedQuery, { userToken });

          // --- Actual Plan Generation ---
          try {
            const plannerResult = await runPlannerWithInputs({
              topKResults,
              refinedQuery,
              apiKey,
              usefulData: str,
              conversationContext,
              finalDeliverable,
              intentType,
              entities,
              requestContext,
              referenceTask
            });
            actionablePlan = plannerResult.actionablePlan;
            plannerRawResponse = plannerResult.planResponse;
          } catch (err: any) {
            console.error('❌ Error during planning phase:', err);
            
            // Handle "No tables selected for SQL generation" error
            if (err.message && err.message.includes('No tables selected for SQL generation')) {
              const reason = err.cause || 'No relevant tables found for this query';
              console.log('📝 Generating LLM response for no tables selected error:', reason);

              const llmMessage = await openaiChatCompletion({
                messages: [
                  {
                    role: 'system',
                    content: `You are a helpful assistant. The user asked a question, but the database doesn't have the necessary information to answer it. Politely explain why the database cannot fulfill their request.`
                  },
                  {
                    role: 'user',
                    content: `User's question: "${refinedQuery}"
                      
  The database schema analysis shows: "${reason}"

  Please provide a friendly explanation of why this question cannot be answered with the current database.`
                  }
                ],
                temperature: 0.7,
                max_tokens: 512,
              });

              output = {
                message: llmMessage || reason,
                refinedQuery,
                final: true,
                reason: reason
              };
                return output;
            }
            
            throw err;
          }

          const planningDurationMs = Date.now() - planningStart;
          console.log(`⏱️ Planning duration (initial): ${planningDurationMs}ms intent=${intentType} refined="${refinedQuery}"`);

          if (actionablePlan?.impossible) {
            console.log('🚫 Returning impossible response from planner (no relevant DB resources).');
            output = {
              message: actionablePlan.message,
              refinedQuery,
              final: true,
              reason: actionablePlan.reason || 'No relevant database resources found'
            };
            return output;
          }

          // Phase 2: Detect if this is a resolution query
          const queryIntent = await detectResolutionVsExecution(refinedQuery, actionablePlan, apiKey);

          if (queryIntent === 'resolution') {
            console.log('🔄 Resolution query detected! Switching to table-only mode and re-planning...');

            // Re-fetch using only tables (filter out API results)
            const tableOnlyResults = topKResults.filter((item: any) =>
              item.id && typeof item.id === 'string' && (item.id.startsWith('table-') || item.id === 'sql-query')
            );

            console.log(`📊 Filtered to ${tableOnlyResults.length} table-only results for resolution`);

            // Re-run planner with table-only context
            const replanStart = Date.now();
            const replanResult = await runPlannerWithInputs({
              topKResults: tableOnlyResults,
              refinedQuery,
              apiKey,
              usefulData: str,
              conversationContext,
              finalDeliverable,
              intentType: 'FETCH', // Force FETCH mode for resolution
              entities,
              requestContext,
              referenceTask
            });
            const replanDurationMs = Date.now() - replanStart;

            actionablePlan = replanResult.actionablePlan;
            plannerRawResponse = replanResult.planResponse;

            if (actionablePlan?.impossible) {
              console.log('🚫 Replanned in table-only mode and still impossible (no relevant DB resources).');
              output = {
                message: actionablePlan.message,
                refinedQuery,
                final: true,
                reason: actionablePlan.reason || 'No relevant database resources found'
              };
                return output;
            }

            console.log(`⏱️ Planning duration (replan resolution): ${replanDurationMs}ms refined="${refinedQuery}"`);
            console.log('✅ Re-planned with table-only context for resolution');
          } else {
            console.log('⚡ Execution query detected! Proceeding with API-based plan');
          }

          // 保留原始finalDeliverable，不被plan覆盖
          // finalDeliverable = actionablePlan.final_deliverable || finalDeliverable;
          const planResponse = plannerRawResponse;
          console.log('Generated Plan:', planResponse);

          // Note: Validation for multi-step dependencies is now handled in the sendToPlanner loop
          // via placeholder detection, which is more robust and handles step dependencies correctly

          // Handle clarification requests
          if (actionablePlan.needs_clarification) {
            output = {
              message: actionablePlan.clarification_question,
              refinedQuery,
              topKResults,
            };
            return output;
          }

          console.log('checkpoint 1');

          // Execute the plan iteratively if execution_plan exists
          if (actionablePlan && Array.isArray(actionablePlan.execution_plan)) {

            console.log('checkpoint 2');
            if (actionablePlan.execution_plan.length === 0) {
              output = {
                message: 'Plan does not include an execution plan.',
                refinedQuery,
                topKResults,
                planResponse,
                planningDurationMs,
                usedReferencePlan: actionablePlan._from_reference_task || false
              };
              return output;
            }
            console.log('checkpoint 3');
            // Build AgentPlan from execution steps and run via executorAgent function
            const agentPlan: AgentPlan = {
              id: `plan-${sessionId}-${Date.now()}`,
              goal: refinedQuery,
              status: 'planning',
              currentTaskIndex: 0,
              context: { userToken },
              metadata: { sessionId, refinedQuery },
              tasks: actionablePlan.execution_plan.map((step: any, idx: number) => {
                // Map API path/method to toolName
                let toolName = '';
                let inputPayload: unknown = step.api.requestBody || {};

                // SQL query execution
                if (step.api.path === '/general/sql/query' && step.api.method === 'post') {
                  toolName = 'dataService';
                }

                // Watchlist operations
                if (step.api.path === '/pokemon/watchlist') {
                  toolName = 'watchlistService';
                  if (step.api.method === 'post') {
                    inputPayload = { action: 'add', payload: step.api.requestBody, userToken };
                  } else if (step.api.method === 'delete') {
                    inputPayload = { action: 'remove', payload: step.api.requestBody, userToken };
                  } else if (step.api.method === 'get') {
                    inputPayload = { action: 'list', userToken };
                  }
                }

                // Add more mappings as needed for other APIs
                if (!toolName) {
                  throw new Error(`No tool mapping found for API path: ${step.api.path}, method: ${step.api.method}`);
                }
                return {
                  id: String(idx + 1),
                  description: step.description,
                  tool: toolName,
                  input: inputPayload,
                  status: 'pending' as const,
                };
              }),
            };
            console.log('checkpoint 4');
            // Execute the plan using the new function-based executorAgent
            const executedPlan = await executorAgent(agentPlan);
            console.log('checkpoint 5');

            // Build response from executed task outputs
            const executedTasks = executedPlan.tasks;
            const firstOutput = executedTasks[0]?.output;

            console.log('checkpoint 6');

            let messageContent: string | undefined;
            if (Array.isArray(firstOutput) && firstOutput.length > 0) {
              const row = firstOutput[0];
              // Prefer the first primitive value in the row for a concise answer
              const firstValue = row && typeof row === 'object'
                ? Object.values(row).find((v) => ['string', 'number', 'boolean'].includes(typeof v))
                : undefined;
              if (firstValue !== undefined) {
                messageContent = String(firstValue);
              }
            }
            if (!messageContent) {
              messageContent = typeof firstOutput === 'string'
                ? firstOutput
                : JSON.stringify(firstOutput ?? {});
            }

            output = {
              message: messageContent,
              refinedQuery,
              topKResults,
              planResponse,
              planningDurationMs,
              usedReferencePlan: actionablePlan._from_reference_task || false,
              executedTasks,
              /** Serialised agent state — pass back as `agentState` + `resumeFromTaskIndex` to replay from any task */
              agentState: serializeAgentState(executedPlan),
            };
            return output;
          }
          // 如果plan为GOAL_COMPLETED或无execution_plan，自动进入final answer生成
          if (
            actionablePlan &&
            (actionablePlan.message?.toLowerCase().includes('goal completed') ||
              (Array.isArray(actionablePlan.execution_plan) && actionablePlan.execution_plan.length === 0))
          ) {
            // 直接用usefulData和accumulatedResults生成最终答案
            const answer = await generateFinalAnswer(
              refinedQuery,
              [],
              apiKey,
              undefined,
              str // usefulData
            );
            output = {
              message: answer,
              refinedQuery,
              topKResults,
              planResponse,
              final: true,
              planningDurationMs,
              usedReferencePlan: actionablePlan._from_reference_task || false
            };
            return output;
          }
          // 否则返回plan does not include an execution plan
          console.log('⚠️ Plan does not include an execution plan, returning plan response without execution');
          output = {
            message: 'Plan does not include an execution plan.',
            refinedQuery,
            topKResults,
            planResponse,
            planningDurationMs,
            usedReferencePlan: actionablePlan._from_reference_task || false
          };
          return output;
        }
      );
    } catch (error: any) {
      console.warn('Error in chat API:', error);
      output = {
        error: 'Internal server error'
      };
    }
    finally {
      // parent?.end();
      const displayOutput = { ...output };
      displayOutput.topKResults = displayOutput.topKResults ? displayOutput.topKResults.length : undefined; // Limit topKResults in logs for readability
      console.log('Final output:', displayOutput);
      span.update({
        output: output
      })
      .end();

      // return NextResponse.json(output);
      return output;
    }
  })
  .then((result) => {
    const displayResult = { ...result };
    displayResult.topKResults = displayResult.topKResults ? displayResult.topKResults.length : undefined; // Limit topKResults in logs for readability
    console.log('chatHandler completed with result:', displayResult);
    return result;
  })
  .catch((err) => {
    console.error('Error in chatHandler:', err);
    return { error: 'Internal server error' };
  });;
}

export const POST = chatHandlerWrapper;
