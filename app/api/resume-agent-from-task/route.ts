/**
 * /api/resume-agent-from-task
 *
 * Dashboard endpoint for Agent Mid-Trace Replay.
 *
 * Accepts a request body in one of two forms:
 *
 * **Direct form** (when the caller already has the serialised state):
 * ```json
 * { "agentState": { ...AgentState }, "taskIndex": 2 }
 * ```
 *
 * **Trace-reference form** (when the dashboard reconstructs state from a base trace):
 * ```json
 * { "baseTraceId": "Trace-1", "taskIndex": 2, "agentId": "executor-agent-001" }
 * ```
 * In the trace-reference form the endpoint reconstructs the `AgentState` from
 * the base trace events stored in Langfuse, then resumes from `taskIndex`.
 * NOTE: Trace-reference reconstruction requires a Langfuse fetch client
 * configured via `LANGFUSE_SECRET_KEY` + `LANGFUSE_HOST` environment variables.
 *
 * Response:
 * ```json
 * {
 *   "planStatus": "completed",
 *   "resumedFromTaskIndex": 2,
 *   "executedTasks": [...],
 *   "agentState": { ...AgentState },
 *   "traceId": "Trace-1-1"
 * }
 * ```
 */
import { NextRequest, NextResponse } from 'next/server';
import { startActiveObservation } from '@langfuse/tracing';
import { LangfuseSpan } from '@langfuse/tracing';
import { edStartTrace, edEndTrace } from '@/ed_workflows';
import {
  AgentState,
  resumeAgentFromTrace,
  serializeAgentState,
} from '@/utils/aiHandler';

/** Reconstruct an `AgentState` by fetching base trace events from Langfuse. */
async function reconstructStateFromTrace(
  baseTraceId: string,
  taskIndex: number,
  _agentId: string,
): Promise<AgentState> {
  const langfuseHost = process.env.LANGFUSE_HOST ?? 'https://cloud.langfuse.com';
  const secretKey = process.env.LANGFUSE_SECRET_KEY;
  const publicKey = process.env.LANGFUSE_PUBLIC_KEY;

  if (!secretKey || !publicKey) {
    throw new Error(
      'reconstructStateFromTrace: LANGFUSE_SECRET_KEY and LANGFUSE_PUBLIC_KEY must be set to reconstruct state from a base trace',
    );
  }

  const credentials = Buffer.from(`${publicKey}:${secretKey}`).toString('base64');
  const url = `${langfuseHost}/api/public/traces/${encodeURIComponent(baseTraceId)}`;

  const res = await fetch(url, {
    headers: { Authorization: `Basic ${credentials}` },
  });

  if (!res.ok) {
    throw new Error(
      `reconstructStateFromTrace: failed to fetch trace "${baseTraceId}" — ${res.status} ${res.statusText}`,
    );
  }

  const traceData = (await res.json()) as {
    id: string;
    observations?: Array<{
      id: string;
      name: string;
      type: string;
      input?: unknown;
      output?: unknown;
      statusMessage?: string;
      startTime?: string;
      endTime?: string;
      metadata?: Record<string, unknown>;
    }>;
  };

  // Extract agent task observations tagged with agentTaskIndex
  const taskObservations = (traceData.observations ?? [])
    .filter((o) => o.metadata?.agentTaskIndex !== undefined)
    .sort(
      (a, b) =>
        Number(a.metadata!.agentTaskIndex) - Number(b.metadata!.agentTaskIndex),
    );

  const tasks = taskObservations.slice(0, taskIndex).map((obs) => ({
    id: String(obs.metadata!.agentTaskId ?? obs.id),
    description: obs.name,
    tool: String(obs.metadata!.tool ?? obs.name),
    input: obs.input,
    output: obs.output,
    status: 'completed' as const,
    startedAt: obs.startTime ? new Date(obs.startTime).getTime() : undefined,
    completedAt: obs.endTime ? new Date(obs.endTime).getTime() : undefined,
  }));

  // Pending tasks (taskIndex onwards) have no output yet
  const pendingTasks = taskObservations.slice(taskIndex).map((obs) => ({
    id: String(obs.metadata!.agentTaskId ?? obs.id),
    description: obs.name,
    tool: String(obs.metadata!.tool ?? obs.name),
    input: obs.input,
    output: undefined,
    status: 'pending' as const,
  }));

  return {
    plan: {
      id: `plan-resume-${baseTraceId}-${taskIndex}`,
      goal: String(traceData.id),
      tasks: [...tasks, ...pendingTasks],
      status: 'paused',
      currentTaskIndex: taskIndex,
      context: {},
      metadata: { baseTraceId },
    },
    trace: [],
    resumeFromTaskIndex: taskIndex,
  };
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON in request body' }, { status: 400 });
  }

  if (typeof body !== 'object' || body === null) {
    return NextResponse.json({ error: 'Request body must be a JSON object' }, { status: 400 });
  }

  const {
    agentState,
    taskIndex,
    baseTraceId,
    agentId,
  } = body as {
    agentState?: AgentState;
    taskIndex?: number;
    baseTraceId?: string;
    agentId?: string;
  };

  // Validate taskIndex is present and valid in either form
  const resolvedTaskIndex = typeof taskIndex === 'number' ? taskIndex : undefined;
  if (resolvedTaskIndex === undefined || resolvedTaskIndex < 0) {
    return NextResponse.json(
      { error: '"taskIndex" must be a non-negative number' },
      { status: 400 },
    );
  }

  // Determine whether we have a direct agentState or need to reconstruct from trace
  const hasDirect = !!agentState;
  const hasTraceRef = !!baseTraceId;

  if (!hasDirect && !hasTraceRef) {
    return NextResponse.json(
      { error: 'Provide either "agentState" (direct) or "baseTraceId" + "agentId" (trace-reference)' },
      { status: 400 },
    );
  }

  await edStartTrace('resumeAgentFromTask');

  // Generate a new trace name following the lineage convention
  const baseId = agentState?.plan?.id ?? baseTraceId ?? 'agent';
  const newTraceId = `${baseId}-resume-${resolvedTaskIndex}-${Date.now()}`;

  return startActiveObservation(
    'resumeAgentFromTask',
    async (span: LangfuseSpan) => {
      span.updateTrace({ name: newTraceId });
      span.update({
        input: {
          taskIndex: resolvedTaskIndex,
          baseTraceId: baseTraceId ?? agentState?.plan?.id,
          agentId,
        },
      });

      try {
        let stateToResume: AgentState;

        if (hasDirect) {
          stateToResume = { ...agentState!, resumeFromTaskIndex: resolvedTaskIndex };
        } else {
          stateToResume = await reconstructStateFromTrace(
            baseTraceId!,
            resolvedTaskIndex,
            agentId ?? '',
          );
        }

        const resumedPlan = await resumeAgentFromTrace(stateToResume);
        const serializedState = serializeAgentState(resumedPlan);

        span.update({ output: { planStatus: resumedPlan.status, traceId: newTraceId } });

        return NextResponse.json({
          planStatus: resumedPlan.status,
          resumedFromTaskIndex: resolvedTaskIndex,
          executedTasks: resumedPlan.tasks,
          agentState: serializedState,
          traceId: newTraceId,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        span.update({ level: 'ERROR', statusMessage: message });
        return NextResponse.json({ error: message }, { status: 500 });
      } finally {
        span.end();
        edEndTrace();
      }
    },
  );
}
