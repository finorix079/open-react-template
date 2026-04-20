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

// ═══════════════════════════════════════════════════════════════
// INTENTIONALLY FAILING TESTS
// These tests use impossibly tight thresholds to guarantee failure.
// They verify that the ed-test framework correctly reports failures.
// ═══════════════════════════════════════════════════════════════

// Impossible latency: 1ms is unreachable for any LLM call (recorded: 852ms)
defineTest({
  name: '[EXPECTED_FAIL] query_refinement_impossible_latency',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_0' },
  benchmarks: { max_duration_ms: 1 },
  run,
});

// Impossible token budget: 1 token is unreachable for planner output (recorded: 2503 tokens)
defineTest({
  name: '[EXPECTED_FAIL] planner_impossible_tokens',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_3' },
  benchmarks: { max_tokens_total: 1 },
  run,
});

// Impossible latency for final synthesizer (recorded: 2583ms)
defineTest({
  name: '[EXPECTED_FAIL] final_synthesizer_impossible_latency',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_9' },
  benchmarks: { max_duration_ms: 1 },
  run,
});

// Both duration and token budgets set impossibly tight
defineTest({
  name: '[EXPECTED_FAIL] data_extractor_impossible_both',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_7' },
  benchmarks: { max_duration_ms: 1, max_tokens_total: 1 },
  run,
});

// Output contains a term that won't be in the intent classifier output
defineTest({
  name: '[EXPECTED_FAIL] intent_classifier_wrong_output',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_4' },
  benchmarks: { output_contains: 'NONEXISTENT_CLASSIFICATION_ZZZZZ' },
  run,
});

// ═══════════════════════════════════════════════════════════════
// CUSTOM INPUT TESTS — SUCCESS EXAMPLES
// Demonstrate overriding the trace's recorded input with static
// values or dynamic async functions. Input is passed to run().
// ═══════════════════════════════════════════════════════════════

/**
 * Static custom input — asks about a different Pokémon while still
 * replaying against the Charizard trace fixture. The benchmark
 * validates the planner's recorded output (from the trace) is within
 * budget, while the uploaded test result shows the custom input.
 */
defineTest({
  name: 'custom_input_static_pikachu',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_3' },
  benchmarks: { max_tokens_total: 5000 },
  input: {
    messages: [
      { role: 'user', content: "What's the attack of Pikachu?" },
    ],
  },
  run: async (input?) => {
    const body = input as { messages: Array<{ role: string; content: string }> };
    const response = await fetch(`${APP_URL}/api/chat-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    await response.text();
  },
});

/**
 * Dynamic custom input — resolves the prompt at runtime from an
 * async function. Useful for sourcing prompts from databases, APIs,
 * or environment variables.
 */
defineTest({
  name: 'custom_input_dynamic_env',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_0' },
  benchmarks: { max_duration_ms: 3000 },
  input: async () => {
    // Simulate fetching from an external source (e.g. prompt registry)
    const pokemonName = process.env.TEST_POKEMON ?? 'Bulbasaur';
    return {
      messages: [
        { role: 'user', content: `What's the attack of ${pokemonName}?` },
      ],
    };
  },
  run: async (input?) => {
    const body = input as { messages: Array<{ role: string; content: string }> };
    const response = await fetch(`${APP_URL}/api/chat-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    await response.text();
  },
});

/**
 * Custom input with output_contains — verifies the query refinement
 * step's recorded output contains "charizard" (case-insensitive).
 */
defineTest({
  name: 'custom_input_with_output_check',
  trace: TRACE,
  target: { type: 'tool_call', step_id: 'tool_call_0' },
  benchmarks: {
    max_duration_ms: 3000,
    output_contains: 'charizard',
  },
  input: {
    messages: [
      { role: 'user', content: "Tell me about Charizard's stats" },
    ],
  },
  run: async (input?) => {
    const body = input as { messages: Array<{ role: string; content: string }> };
    const response = await fetch(`${APP_URL}/api/chat-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    await response.text();
  },
});

// ═══════════════════════════════════════════════════════════════
// CUSTOM INPUT TESTS — EXPECTED FAILURE EXAMPLES
// These use custom inputs paired with benchmarks that will fail
// against the recorded trace data.
// ═══════════════════════════════════════════════════════════════

/**
 * [EXPECTED_FAIL] Custom input with wrong output assertion.
 * Asks about Pikachu but the trace contains Charizard data —
 * output_contains "pikachu" will fail because the recorded output
 * is about Charizard.
 */
defineTest({
  name: '[EXPECTED_FAIL] custom_input_wrong_pokemon_assertion',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_9' },
  benchmarks: {
    output_contains: 'pikachu',
  },
  input: {
    messages: [
      { role: 'user', content: "What's the attack of Pikachu?" },
    ],
  },
  run: async (input?) => {
    const body = input as { messages: Array<{ role: string; content: string }> };
    const response = await fetch(`${APP_URL}/api/chat-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    await response.text();
  },
});

/**
 * [EXPECTED_FAIL] Custom input with impossibly tight token budget.
 * The dynamic input resolves fine but the benchmark (1 token) is
 * impossible against the recorded trace (2503 tokens).
 */
defineTest({
  name: '[EXPECTED_FAIL] custom_input_dynamic_impossible_tokens',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_3' },
  benchmarks: { max_tokens_total: 1 },
  input: async () => ({
    messages: [
      { role: 'user', content: "What's the defense of Snorlax?" },
    ],
  }),
  run: async (input?) => {
    const body = input as { messages: Array<{ role: string; content: string }> };
    const response = await fetch(`${APP_URL}/api/chat-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    await response.text();
  },
});

/**
 * [EXPECTED_FAIL] Custom input with output_not_contains failing.
 * Asserts that the data extractor output does NOT contain "charizard",
 * but it does (the trace is about Charizard).
 */
defineTest({
  name: '[EXPECTED_FAIL] custom_input_forbidden_output',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_7' },
  benchmarks: {
    output_not_contains: 'charizard',
  },
  input: {
    messages: [
      { role: 'user', content: "What's the attack of Charizard?" },
    ],
  },
  run: async (input?) => {
    const body = input as { messages: Array<{ role: string; content: string }> };
    const response = await fetch(`${APP_URL}/api/chat-stream`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${await response.text()}`);
    }
    await response.text();
  },
});

// ═══════════════════════════════════════════════════════════════
// LLM-AS-A-JUDGE TESTS
// These tests use the llm_judge benchmark to evaluate output quality.
// Provider/model fall back to the user's evaluator config from the
// ElasticDash backend if not specified here.
// ═══════════════════════════════════════════════════════════════

// Judge whether the planner correctly identifies fetching Charizard data
defineTest({
  name: '[LLM_JUDGE] planner_quality',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_3' },
  benchmarks: {
    llm_judge: {
      judge_prompt:
        'Does this execution plan correctly identify the need to fetch Charizard\'s data from a Pokémon API? Does it include a concrete API call like GET /pokemon/charizard?',
      judge_score_threshold: 7,
    },
  },
  run,
});

// Judge whether the data extractor correctly pulled the attack stat
defineTest({
  name: '[LLM_JUDGE] data_extractor_quality',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_7' },
  benchmarks: {
    llm_judge: {
      judge_prompt:
        'Does this data extraction correctly identify Charizard\'s attack stat (should be 84) from the raw API response? Is the extracted data well-structured and relevant?',
      judge_score_threshold: 7,
    },
  },
  run,
});

// Judge the final synthesized answer for correctness and clarity
defineTest({
  name: '[LLM_JUDGE] final_answer_quality',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_9' },
  benchmarks: {
    llm_judge: {
      judge_prompt:
        'Does this final answer correctly state Charizard\'s attack stat of 84? Is it presented clearly and helpfully to the user? Does it avoid hallucinated or incorrect information?',
      judge_score_threshold: 7,
    },
  },
  run,
});

// Judge with explicit provider override (uses local ANTHROPIC_API_KEY)
defineTest({
  name: '[LLM_JUDGE] intent_classifier_accuracy',
  trace: TRACE,
  target: { type: 'ai_call', step_id: 'ai_call_4' },
  benchmarks: {
    llm_judge: {
      judge_prompt:
        'The user asked "What\'s the attack of Charizard?" after a prior resolved query about Mewtwo. Does the intent classification correctly identify this as a new data-retrieval request that requires API execution (not a follow-up that can be resolved from context)?',
      judge_score_threshold: 7,
      judge_provider: 'claude',
    },
  },
  run,
});
