/**
 * services/conversationDb.ts
 *
 * File-backed session store persisted to .temp/sessions.json.
 *
 * Used by the long-polling approval flow in /api/chat-stream:
 *   1. When a plan is sent to the client, the session is registered here
 *      with status 'pending'.
 *   2. POST /api/approve writes 'approved' or 'rejected'.
 *   3. The blocking checkApprovalStatus tool detects the change and continues.
 *
 * Sessions are stored in .temp/sessions.json so they persist across server
 * restarts and can be shared across processes (e.g. dashboard rerun).
 */

import fs from 'fs';
import path from 'path';

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'completed';

export interface ConversationSession {
  sessionId: string;
  status: ApprovalStatus;
  createdAt: number;
  updatedAt: number;
}

const SESSIONS_FILE = path.join(process.cwd(), '.temp', 'sessions.json');

/** Reads all sessions from disk. Returns an empty object if the file is missing or corrupt. */
function readSessions(): Record<string, ConversationSession> {
  try {
    const raw = fs.readFileSync(SESSIONS_FILE, 'utf-8');
    return JSON.parse(raw) as Record<string, ConversationSession>;
  } catch {
    return {};
  }
}

/** Writes the full sessions object to disk atomically. */
function writeSessions(sessions: Record<string, ConversationSession>): void {
  const dir = path.dirname(SESSIONS_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf-8');
}

// Clean up sessions older than 10 minutes every 5 minutes.
setInterval(() => {
  const cutoff = Date.now() - 10 * 60 * 1_000;
  const sessions = readSessions();
  let changed = false;
  for (const id of Object.keys(sessions)) {
    if (sessions[id].updatedAt < cutoff) {
      delete sessions[id];
      changed = true;
    }
  }
  if (changed) writeSessions(sessions);
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
  const sessions = readSessions();
  sessions[sessionId] = session;
  writeSessions(sessions);
  return session;
}

/**
 * Returns the current session record, or undefined if it does not exist.
 * Reads from disk every time so cross-process changes are visible immediately.
 */
export function getSession(sessionId: string): ConversationSession | undefined {
  const sessions = readSessions();
  return sessions[sessionId];
}

/**
 * Updates the approval status for an existing session.
 * No-ops if the session does not exist.
 */
export function setApprovalStatus(sessionId: string, status: ApprovalStatus): void {
  const sessions = readSessions();
  const session = sessions[sessionId];
  if (session) {
    session.status = status;
    session.updatedAt = Date.now();
    sessions[sessionId] = session;
    writeSessions(sessions);
  }
}

/**
 * Removes a session from the store.
 */
export function deleteSession(sessionId: string): void {
  const sessions = readSessions();
  delete sessions[sessionId];
  writeSessions(sessions);
}
