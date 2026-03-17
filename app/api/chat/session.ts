/**
 * session.ts
 * Manages in-memory pending plan storage and session ID generation for the chat approval workflow.
 */
import { Message } from '@/services/chatPlannerService';
import { SavedTask } from '@/services/taskService';

/** In-memory store for plans awaiting user approval. Key: sessionId */
export const pendingPlans = new Map<string, {
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
}>();

// Clean up old pending plans (older than 1 hour)
setInterval(() => {
  const now = Date.now();
  for (const [sessionId, data] of pendingPlans.entries()) {
    if (now - data.timestamp > 3600000) {
      pendingPlans.delete(sessionId);
    }
  }
}, 300000); // Run every 5 minutes

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
