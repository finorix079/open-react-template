/**
 * ed_tests.ts
 *
 * ElasticDash benchmark tests for the chatStreamHandler workflow.
 * Uses the defineTest API with recorded trace fixtures for deterministic CI replay.
 *
 * Trace: .ed_traces/2026-04-19T06-54-40_32b4.json
 * Workflow: chatStreamHandler — "What's the attack of Charizard?"
 *
 * Generated from trace analysis on 2026-04-19.
 */

import { defineTest } from 'elasticdash-test';

const TRACE = './.ed_traces/2026-04-19T06-54-40_32b4.json';
const APP_URL = process.env.APP_URL ?? 'http://localhost:3006';

/** Invokes chatStreamHandler via HTTP against the running dev server. */
const run = async () => {
  const response = await fetch(`${APP_URL}/api/chat-stream`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      messages: [
        { role: 'user', content: "What's the attack of Mewtwo" },
        { role: 'assistant', content: 'Mewtwo has an attack stat of **110**.\n\n---\n\n**Steps taken:**\n\n1. **Fetch full details for Mewtwo to retrieve its attack stat**\n   `GET /pokemon/mewtwo`' },
        { role: 'user', content: "What's the attack of Charizard?" },
      ],
    }),
  });
  if (!response.ok) {
    throw new Error(`chatStreamHandler HTTP ${response.status}: ${await response.text()}`);
  }
  await response.text();
};

// ─── Query Refinement (ai_call_0) ────────────────────────────
// First LLM call: refines the user's raw query into structured format.
// Model: gpt-4o | Recorded: 852ms, 1842 tokens
defineTest({
  name: 'query_refinement_latency',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_0' },
  benchmarks: { max_duration_ms: 3000 },
  run,
});

defineTest({
  name: 'query_refinement_tokens',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_0' },
  benchmarks: { max_tokens_total: 5000 },
  run,
});

// ─── queryRefinement Tool Call (tool_call_0) ─────────────────
// Wraps the LLM refinement as a tool call.
// Recorded: 852ms
defineTest({
  name: 'query_refinement_tool_latency',
  trace: TRACE,
  target: { type: 'tool_call', step_id: 'tool_call_0' },
  benchmarks: { max_duration_ms: 3000 },
  run,
});

// ─── Goal Completion Validator (ai_call_2) ───────────────────
// Checks whether existing data already satisfies the user's goal.
// Model: gpt-4o | Recorded: 532ms, 194 tokens
defineTest({
  name: 'goal_validator_latency',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_2' },
  benchmarks: { max_duration_ms: 2000 },
  run,
});

defineTest({
  name: 'goal_validator_tokens',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_2' },
  benchmarks: { max_tokens_total: 500 },
  run,
});

// ─── Planner (ai_call_3) ────────────────────────────────────
// Generates the execution plan (GET /pokemon/charizard).
// Model: gpt-4o | Recorded: 999ms, 2503 tokens
defineTest({
  name: 'planner_latency',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_3' },
  benchmarks: { max_duration_ms: 5000 },
  run,
});

defineTest({
  name: 'planner_tokens',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_3' },
  benchmarks: { max_tokens_total: 5000 },
  run,
});

// ─── Intent Classifier (ai_call_4) ──────────────────────────
// Classifies query as "resolution" or "execution".
// Model: kimi-k2 | Recorded: 792ms, 290 tokens
defineTest({
  name: 'intent_classifier_latency',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_4' },
  benchmarks: { max_duration_ms: 3000 },
  run,
});

defineTest({
  name: 'intent_classifier_tokens',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_4' },
  benchmarks: { max_tokens_total: 500 },
  run,
});

// ─── fetchPokemonDetails Tool Call (tool_call_2) ─────────────
// Actual PokéAPI call: GET /pokemon/charizard
// Recorded: 643ms
defineTest({
  name: 'fetch_pokemon_details_latency',
  trace: TRACE,
  target: { type: 'tool_call', step_id: 'tool_call_2' },
  benchmarks: { max_duration_ms: 5000 },
  run,
});

// ─── Data Extractor (ai_call_7) ─────────────────────────────
// Extracts useful data from the PokéAPI response.
// Model: kimi-k2 | Recorded: 3069ms, 4828 tokens
defineTest({
  name: 'data_extractor_latency',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_7' },
  benchmarks: { max_duration_ms: 10000 },
  run,
});

defineTest({
  name: 'data_extractor_tokens',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_7' },
  benchmarks: { max_tokens_total: 10000 },
  run,
});

// ─── Completion Validator (ai_call_8) ────────────────────────
// Validates that Charizard's attack stat was successfully retrieved.
// Model: gpt-4o | Recorded: 1367ms, 14048 tokens
defineTest({
  name: 'completion_validator_latency',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_8' },
  benchmarks: { max_duration_ms: 10000 },
  run,
});

defineTest({
  name: 'completion_validator_tokens',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_8' },
  benchmarks: { max_tokens_total: 20000 },
  run,
});

// ─── Final Answer Synthesizer (ai_call_9) ────────────────────
// Synthesizes the final user-facing response.
// Model: gpt-4o | Recorded: 2583ms, 6829 tokens
defineTest({
  name: 'final_synthesizer_latency',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_9' },
  benchmarks: { max_duration_ms: 10000 },
  run,
});

defineTest({
  name: 'final_synthesizer_tokens',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_9' },
  benchmarks: { max_tokens_total: 15000 },
  run,
});

// ─── Claude Final Answer (ai_call_10) ────────────────────────
// Claude Sonnet generates the streaming final answer.
// Model: claude-sonnet | Recorded: 1115ms, 15 tokens
defineTest({
  name: 'claude_final_answer_latency',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_10' },
  benchmarks: { max_duration_ms: 5000 },
  run,
});

defineTest({
  name: 'claude_final_answer_tokens',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_10' },
  benchmarks: { max_tokens_total: 500 },
  run,
});
