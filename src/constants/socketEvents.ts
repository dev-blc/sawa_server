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

  // ─── Us space ────────────────────────────────────────────────────────────────
  // Ambient partner presence in the couple room. Server → Client only, payload
  // { userId, online: boolean }. Socket-only by design: no Notification row, no
  // push (see src/sockets/index.ts).
  US_PARTNER_PRESENCE: 'us:partner:presence',

  // Couple games (src/sockets/us.socket.ts). LEAVE is the soft exit — board
  // closed, session kept for resume; QUIT is the hard exit — session cleared.
  US_GAME_CHALLENGE: 'us:game:challenge',
  US_GAME_ACCEPT: 'us:game:accept',
  US_GAME_START: 'us:game:start',
  US_GAME_MOVE: 'us:game:move',
  US_GAME_LEAVE: 'us:game:leave',
  US_GAME_PARTNER_LEFT: 'us:game:partner-left',
  US_GAME_QUIT: 'us:game:quit',
  US_GAME_RESULT: 'us:game:result',
  US_GAME_POINTS: 'us:game:points',

  // ─── Errors ─────────────────────────────────────────────────────────────────
  ERROR: 'error',
} as const;

export type SocketEvent = (typeof SOCKET_EVENTS)[keyof typeof SOCKET_EVENTS];
