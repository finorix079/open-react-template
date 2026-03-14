/**
 * services/conversationDb.ts
 *
 * In-memory session store shared across the same Node.js process.
 *
 * Used by the long-polling approval flow in /api/chat-stream:
 *   1. When a plan is sent to the client, the session is registered here
 *      with status 'pending'.
 *   2. POST /api/approve writes 'approved' or 'rejected'.
 *   3. The polling loop in /api/chat-stream detects the change and continues.
 *
 * Because Next.js runs API routes in the same Node.js process (in development
 * and on a single-instance deployment), the Map is visible to all routes.
 * For multi-instance deployments this would need to be replaced with Redis or
 * a similar shared store.
 */

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'completed';

export interface ConversationSession {
  sessionId: string;
  status: ApprovalStatus;
  createdAt: number;
  updatedAt: number;
}

/** In-memory store keyed by sessionId. */
const sessions = new Map<string, ConversationSession>();

// Clean up sessions older than 10 minutes every 5 minutes.
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1_000;
  for (const [id, session] of sessions.entries()) {
    if (session.updatedAt < cutoff) {
      sessions.delete(id);
    }
  }
}, 5 * 60 * 1_000);

/**
 * Registers or resets a session with 'pending' status.
 * Call this when a plan is sent to the client and approval is being awaited.
 */
export function createSession(sessionId: string): ConversationSession {
  const now = Date.now();
  const session: ConversationSession = {
    sessionId,
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  };
  sessions.set(sessionId, session);
  return session;
}

/**
 * Returns the current session record, or undefined if it does not exist.
 */
export function getSession(sessionId: string): ConversationSession | undefined {
  return sessions.get(sessionId);
}

/**
 * Updates the approval status for an existing session.
 * No-ops if the session does not exist.
 */
export function setApprovalStatus(sessionId: string, status: ApprovalStatus): void {
  const session = sessions.get(sessionId);
  if (session) {
    session.status = status;
    session.updatedAt = Date.now();
  }
}

/**
 * Removes a session from the store.
 */
export function deleteSession(sessionId: string): void {
  sessions.delete(sessionId);
}
