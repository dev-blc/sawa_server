/**
 * Socket.io event name constants.
 * Always use these instead of raw strings.
 */
export const SOCKET_EVENTS = {
  // ─── Connection ─────────────────────────────────────────────────────────────
  CONNECT: 'connect',
  DISCONNECT: 'disconnect',

  // ─── Chat ───────────────────────────────────────────────────────────────────
  CHAT_JOIN: 'chat:join',
  CHAT_LEAVE: 'chat:leave',
  CHAT_MESSAGE: 'chat:message',
  CHAT_READ: 'chat:read',
  CHAT_TYPING: 'chat:typing',
  CHAT_STOP_TYPING: 'chat:stopTyping',

  
  // ─── Match ──────────────────────────────────────────────────────────────────
  MATCH_NEW: 'match:new',
  MATCH_ACCEPTED: 'match:accepted',
  MATCH_REJECTED: 'match:rejected',

  // ─── Errors ─────────────────────────────────────────────────────────────────
  ERROR: 'error',
} as const;

export type SocketEvent = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];
