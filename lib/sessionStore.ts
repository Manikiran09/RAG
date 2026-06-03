import type { DemoSession } from "./types";

const sessions = new Map<string, DemoSession>();

export function createSessionId() {
  return crypto.randomUUID();
}

export function saveSession(sessionId: string, session: DemoSession) {
  sessions.set(sessionId, session);
}

export function getSession(sessionId: string) {
  return sessions.get(sessionId) ?? null;
}
