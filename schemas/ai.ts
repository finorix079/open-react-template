/**
 * schemas/ai.ts
 *
 * Zod schemas for all structured LLM outputs and API route inputs.
 *
 * These schemas are used with the Vercel AI SDK's `generateObject()` function
 * which calls OpenAI in JSON-schema mode, guaranteeing the response matches
 * the schema before returning — no more regex + JSON.parse + manual repair.
 *
 * Also used for API route input validation via `ZodSchema.safeParse()`.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared primitives
// ---------------------------------------------------------------------------

export const IntentTypeSchema = z.enum(['FETCH', 'MODIFY']);

// ---------------------------------------------------------------------------
// Query refinement (utils/queryRefinement.ts)
// ---------------------------------------------------------------------------

/**
 * Structured output from `clarifyAndRefineUserInput`.
 * Replaces regex-based field extraction from a freeform LLM response.
 */
export const QueryRefinementSchema = z.object({
  /** Clearer, normalised version of the user's question. */
  refinedQuery: z.string(),
  /** ISO 639-1 language code (e.g. "EN", "ZH"). */
  language: z.string(),
  /** Key domain concepts present in the query. */
  concepts: z.array(z.string()),
  /** API functionalities required to answer the query. */
  apiNeeds: z.array(z.string()),
  /** Entity names / data sources that need investigation. */
  entities: z.array(z.string()),
  /** Whether this is a read-only or mutation query. */
  intentType: IntentTypeSchema,
});

export type QueryRefinement = z.infer<typeof QueryRefinementSchema>;

// ---------------------------------------------------------------------------
// Planner intent analysis (app/api/chat/planner.ts — Step 1)
// ---------------------------------------------------------------------------

/**
 * The next-step intent object returned by the intent-analysis LLM call.
 * Replaces brittle JSON repair (`replace(/，/g, ',')` etc.) with a proper schema.
 */
export const IntentSchema = z.object({
  /** One-sentence description of the single most critical next action. */
  description: z.string(),
  /** Whether this next action is a read or a mutation. */
  type: IntentTypeSchema,
});

export type Intent = z.infer<typeof IntentSchema>;

// ---------------------------------------------------------------------------
// Execution plan (app/api/chat/planner.ts — Step 3)
// ---------------------------------------------------------------------------

export const ApiCallSchema = z.object({
  path: z.string(),
  method: z.string(),
  parameters: z.record(z.string(), z.unknown()).nullable().optional(),
  requestBody: z.record(z.string(), z.unknown()).nullable().optional(),
});

export const ExecutionStepSchema = z.object({
  step_number: z.number(),
  description: z.string(),
  api: ApiCallSchema.nullable().optional(),
  depends_on_step: z.number().nullable().optional(),
});

/**
 * The complete execution plan returned by the planner LLM.
 * Replaces `match(/\{[\s\S]*\}/)` + `JSON.parse()`.
 */
export const ExecutionPlanSchema = z.object({
  needs_clarification: z.boolean(),
  clarification_question: z.string().optional(),
  // propertyNames: z.array(z.string()).default([]), // to prevent OpenAI's structured-output mode from rejecting the response due to unknown schema properties
  execution_plan: z.array(ExecutionStepSchema).nullable().optional(),
  /** Set to true when the goal is already complete. */
  message: z.string().nullable().optional(),
  /** Set to true when the system cannot handle the query. */
  impossible: z.boolean().nullable().optional(),
  reason: z.string().nullable().optional(),
  selected_tools_spec: z.array(z.unknown()).nullable().optional(),
});

export type ExecutionPlan = z.infer<typeof ExecutionPlanSchema>;

// ---------------------------------------------------------------------------
// Planner SQL/schema validation (app/api/chat/planner.ts — Step 3 validation)
// ---------------------------------------------------------------------------

/**
 * Validation result from the SQL/schema consistency checker.
 * Replaces `match(/\{[\s\S]*\}/)` + `JSON.parse()` on the validator response.
 */
export const PlannerValidationSchema = z.object({
  needs_clarification: z.boolean(),
  reason: z.string().nullable().optional(),
  clarification_question: z.string().optional(),
  propertyNames: z.array(z.string()).default([]), // to prevent OpenAI's structured-output mode from rejecting the response due to unknown schema properties
});

export type PlannerValidation = z.infer<typeof PlannerValidationSchema>;

// ---------------------------------------------------------------------------
// Table selection (app/api/chat/plannerUtils.ts)
// ---------------------------------------------------------------------------

/**
 * Table-selection decision returned by Kimi when choosing which DB tables
 * to use for SQL generation.
 * Replaces `match(/\{[\s\S]*\}/)` + `JSON.parse()`.
 */
export const TableSelectionSchema = z.object({
  /** Table IDs or names chosen for this query. */
  selected_tables: z.array(z.string()),
  /** Specific columns of interest per table. */
  focus_columns: z.record(z.string(), z.array(z.string())),
  /** Brief explanation of the selection. */
  reasoning: z.string(),
});

export type TableSelection = z.infer<typeof TableSelectionSchema>;

// ---------------------------------------------------------------------------
// Goal validation (app/api/chat/validators.ts)
// ---------------------------------------------------------------------------

/**
 * Decision returned by `validateNeedMoreActions`.
 * Replaces `match(/\{[\s\S]*\}/)` + `JSON.parse()` on the validator response.
 */
export const NeedMoreActionsSchema = z.object({
  needsMoreActions: z.boolean(),
  reason: z.string(),
  missing_requirements: z.array(z.string()).nullable().optional(),
  suggested_next_action: z.string().nullable().optional(),
  useful_data: z.string().nullable().optional(),
  item_not_found: z.boolean().nullable().optional(),
});

export type NeedMoreActions = z.infer<typeof NeedMoreActionsSchema>;

// ---------------------------------------------------------------------------
// API route input validation
// ---------------------------------------------------------------------------

/**
 * Request body schema for POST /api/chat-stream.
 */
export const ChatStreamRequestSchema = z.object({
  messages: z.array(
    z.object({
      role: z.enum(['user', 'assistant', 'system']),
      content: z.string(),
    }),
  ),
  sessionId: z.string().optional(),
});

export type ChatStreamRequest = z.infer<typeof ChatStreamRequestSchema>;

/**
 * Request body schema for POST /api/approve.
 */
export const ApproveRequestSchema = z.object({
  sessionId: z.string().min(1),
  approved: z.boolean(),
});

export type ApproveRequest = z.infer<typeof ApproveRequestSchema>;
