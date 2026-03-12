/**
 * session.ts
 * Manages in-memory pending plan storage and session ID generation for the chat approval workflow.
 * Plans are written through to the local JSON file DB (services/conversationDb.ts) so that the
 * approval-polling loop in the SSE stream can detect decisions made via POST /api/approve.
 */
import { Message } from '@/services/chatPlannerService';
import { SavedTask } from '@/services/taskService';
import { upsertSession, pruneOldSessions } from '@/services/conversationDb';

export interface PendingPlanEntry {
  plan: any;
  planResponse: string;
  refinedQuery: string;
  topKResults: any[];
  conversationContext: string;
  finalDeliverable: string;
  entities: any[];
  intentType: 'FETCH' | 'MODIFY';
  timestamp: number;
  referenceTask?: SavedTask;
}

/** In-memory cache of plans awaiting user approval. Key: sessionId */
export const pendingPlans = new Map<string, PendingPlanEntry>();

/**
 * Stores a pending plan both in the in-memory cache and the local JSON file DB.
 * The file DB is what the SSE polling loop reads to detect approval.
 *
 * @param sessionId - Stable session identifier for this conversation.
 * @param entry     - All data required to execute the plan once approved.
 * @param messages  - Current conversation messages (stored for context).
 */
export function storePendingPlan(
  sessionId: string,
  entry: PendingPlanEntry,
  messages: Message[],
): void {
  pendingPlans.set(sessionId, entry);

  upsertSession({
    sessionId,
    status: 'pending_approval',
    messages: messages as { role: 'user' | 'assistant'; content: string }[],
    pendingPlanData: {
      plan: entry.plan,
      planResponse: entry.planResponse,
      refinedQuery: entry.refinedQuery,
      topKResults: entry.topKResults,
      conversationContext: entry.conversationContext,
      finalDeliverable: entry.finalDeliverable,
      entities: entry.entities,
      intentType: entry.intentType,
      referenceTask: entry.referenceTask,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

// Prune expired sessions from the JSON file DB every 5 minutes
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, data] of pendingPlans.entries()) {
    if (now - data.timestamp > 3_600_000) {
      pendingPlans.delete(sessionId);
    }
  }
  pruneOldSessions();
}, 300_000);

/**
 * Generates a stable session ID from conversation messages.
 * Uses all messages except the last one so the ID stays the same
 * when the user sends an approval message.
 */
export function generateSessionId(messages: Message[]): string {
  const messagesForHash = messages.slice(0, -1);

  if (messagesForHash.length === 0) {
    return `session_new_${Date.now()}`;
  }

  const keyMessages = [
    ...messagesForHash.slice(0, Math.min(3, messagesForHash.length)),
    messagesForHash[messagesForHash.length - 1],
  ].filter(Boolean);

  const content = keyMessages.map(m => `${m.role}:${m.content}`).join('|');
  let hash = 0;
  for (let i = 0; i < content.length; i++) {
    const char = content.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return `session_${Math.abs(hash)}`;
}
