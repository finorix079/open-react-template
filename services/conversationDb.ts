/**
 * services/conversationDb.ts
 *
 * Lightweight local JSON file database for persisting conversation sessions,
 * pending plan data, and approval status across requests.
 *
 * DB file: .temp/conversations.json
 *
 * Schema:
 * {
 *   sessions: {
 *     [sessionId: string]: ConversationSession
 *   }
 * }
 *
 * Usage:
 *   import { upsertSession, getSession, setApprovalStatus } from '@/services/conversationDb';
 */

import fs from 'fs';
import path from 'path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ApprovalStatus = 'pending_approval' | 'approved' | 'rejected' | 'completed';

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** All data the stream needs to execute a plan after approval. */
export interface PendingPlanData {
  plan: Record<string, unknown>;
  planResponse: string;
  refinedQuery: string;
  topKResults: unknown[];
  conversationContext: string;
  finalDeliverable: string;
  entities: unknown[];
  intentType: 'FETCH' | 'MODIFY';
  referenceTask?: unknown;
}

export interface ConversationSession {
  sessionId: string;
  status: ApprovalStatus;
  messages: ConversationMessage[];
  pendingPlanData?: PendingPlanData;
  createdAt: string;
  updatedAt: string;
}

interface ConversationDb {
  sessions: Record<string, ConversationSession>;
}

// ---------------------------------------------------------------------------
// File path
// ---------------------------------------------------------------------------

const DB_PATH = path.join(process.cwd(), '.temp', 'conversations.json');

// ---------------------------------------------------------------------------
// Internal read/write helpers
// ---------------------------------------------------------------------------

/**
 * Reads the full DB from disk. Returns an empty DB object if the file does not
 * exist or cannot be parsed.
 */
export function readDb(): ConversationDb {
  try {
    if (!fs.existsSync(DB_PATH)) {
      return { sessions: {} };
    }
    const raw = fs.readFileSync(DB_PATH, 'utf-8');
    return JSON.parse(raw) as ConversationDb;
  } catch {
    // Corrupt or missing file — start fresh
    return { sessions: {} };
  }
}

/**
 * Writes the full DB object to disk synchronously.
 * Synchronous writes prevent concurrent-request corruption.
 */
export function writeDb(db: ConversationDb): void {
  const dir = path.dirname(DB_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates or fully replaces a session record.
 *
 * @param session - The session object to write. `updatedAt` is always refreshed.
 */
export function upsertSession(session: ConversationSession): void {
  const db = readDb();
  db.sessions[session.sessionId] = {
    ...session,
    updatedAt: new Date().toISOString(),
  };
  writeDb(db);
}

/**
 * Returns the session for `sessionId`, or `undefined` if it does not exist.
 */
export function getSession(sessionId: string): ConversationSession | undefined {
  const db = readDb();
  return db.sessions[sessionId];
}

/**
 * Updates only the `status` and `updatedAt` fields of an existing session.
 * If the session does not exist, this is a no-op.
 *
 * @param sessionId - The session to update.
 * @param status    - The new approval status.
 */
export function setApprovalStatus(sessionId: string, status: ApprovalStatus): void {
  const db = readDb();
  const existing = db.sessions[sessionId];
  if (!existing) return;
  db.sessions[sessionId] = {
    ...existing,
    status,
    updatedAt: new Date().toISOString(),
  };
  writeDb(db);
}

/**
 * Appends a message to the session's message history.
 * If the session does not exist, this is a no-op.
 */
export function appendMessage(sessionId: string, message: ConversationMessage): void {
  const db = readDb();
  const existing = db.sessions[sessionId];
  if (!existing) return;
  db.sessions[sessionId] = {
    ...existing,
    messages: [...existing.messages, message],
    updatedAt: new Date().toISOString(),
  };
  writeDb(db);
}

/**
 * Removes sessions older than `maxAgeMs` milliseconds (default: 1 hour).
 * Call this periodically to prevent unbounded file growth.
 */
export function pruneOldSessions(maxAgeMs = 3_600_000): void {
  const db = readDb();
  const cutoff = Date.now() - maxAgeMs;
  for (const [id, session] of Object.entries(db.sessions)) {
    if (new Date(session.updatedAt).getTime() < cutoff) {
      delete db.sessions[id];
    }
  }
  writeDb(db);
}
