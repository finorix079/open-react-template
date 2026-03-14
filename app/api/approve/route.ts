/**
 * app/api/approve/route.ts
 *
 * Receives a user's approval or rejection decision for a pending plan and
 * writes it to the in-memory conversationDb. The long-polling loop inside
 * POST /api/chat-stream detects the change and either executes the plan or
 * emits a rejection message — all within the original streaming response.
 *
 * POST /api/approve
 * Body: { sessionId: string; approved: boolean }
 * Response: 200 { ok: true } | 400/404 JSON error
 */

import { NextRequest, NextResponse } from 'next/server';
import { ApproveRequestSchema } from '@/schemas/ai';
import { getSession, setApprovalStatus } from '@/services/conversationDb';

/**
 * POST /api/approve
 *
 * Records the user's approval or rejection for a pending plan.
 * The corresponding SSE stream in /api/chat-stream will detect the decision
 * on its next poll and continue execution or emit a rejection message.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = ApproveRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return NextResponse.json({ error: parsed.error.message }, { status: 400 });
  }

  const { sessionId, approved } = parsed.data;

  const session = getSession(sessionId);
  if (!session) {
    return NextResponse.json(
      { error: `No pending plan found for session "${sessionId}". It may have already been processed or expired.` },
      { status: 404 },
    );
  }

  if (session.status !== 'pending') {
    return NextResponse.json(
      { error: `Session "${sessionId}" is not awaiting approval (status: ${session.status}).` },
      { status: 409 },
    );
  }

  setApprovalStatus(sessionId, approved ? 'approved' : 'rejected');

  return NextResponse.json({ ok: true });
}
