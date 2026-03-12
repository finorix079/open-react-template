/**
 * app/api/approve/route.ts
 *
 * REST endpoint called by the frontend when the user clicks "Approve" or "Reject"
 * on a pending plan. This updates the local JSON file DB so the still-open SSE
 * stream in /api/chat-stream can detect the decision and continue execution
 * within the same session — no new stream is opened.
 *
 * POST /api/approve
 *   Body: { sessionId: string; approved: boolean }
 *   Response: { ok: true } | { error: string }
 */

import { NextRequest } from 'next/server';
import { setApprovalStatus, getSession } from '@/services/conversationDb';
import { ApproveRequestSchema } from '@/schemas/ai';

/**
 * Handles the approval or rejection of a pending execution plan.
 * Writes the decision to the conversation DB; the waiting SSE stream polls
 * that DB and will pick up the change within its next poll interval (~2 s).
 */
export async function POST(request: NextRequest): Promise<Response> {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body' }, { status: 400 });
  }

  const parsed = ApproveRequestSchema.safeParse(rawBody);
  if (!parsed.success) {
    return Response.json({ error: parsed.error.message }, { status: 400 });
  }

  const { sessionId, approved } = parsed.data;

  const session = getSession(sessionId);
  if (!session) {
    return Response.json({ error: 'Session not found or already expired' }, { status: 404 });
  }

  if (session.status !== 'pending_approval') {
    // Idempotent — already processed
    return Response.json({ ok: true, alreadyProcessed: true });
  }

  setApprovalStatus(sessionId, approved ? 'approved' : 'rejected');

  return Response.json({ ok: true });
}
