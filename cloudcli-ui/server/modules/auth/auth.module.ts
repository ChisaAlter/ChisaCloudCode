import { createRequire } from 'node:module';

import { userDb } from '@/modules/database/index.js';
import { IS_PLATFORM } from '@/shared/index.js';

import { authenticateToken, generateToken, refreshToken, revokeSession, requireActiveAuthSession } from './auth.middleware.js';
import { createAuthRouter } from './auth.routes.js';
import { createAuthService } from './auth.service.js';
import { createWebSocketTicketService } from './websocket-ticket.service.js';

type BcryptAdapter = {
  compare(password: string, passwordHash: string): Promise<boolean>;
};

// bcrypt does not ship TypeScript declarations in this project, so the
// composition root narrows its CommonJS runtime surface before injecting it.
const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt') as BcryptAdapter;
const websocketTickets = createWebSocketTicketService({
  isSessionActive: (id, userId, version) => { requireActiveAuthSession(id, userId, version); return true; },
  getUser: userDb.getUserById,
});
const authService = createAuthService({
  users: {
    getUserByUsername: (username) => userDb.getUserByUsername(username),
    updateLastLogin: (userId) => userDb.updateLastLogin(userId),
    updateProfile: (userId, displayName, avatarDataUrl) => userDb.updateProfile(userId, displayName, avatarDataUrl),
  },
  comparePassword: (password, passwordHash) => bcrypt.compare(password, passwordHash),
  generateToken,
  refreshToken,
  revokeSession,
  issueWebSocketTicket: websocketTickets.issue,
  isPlatform: IS_PLATFORM,
});

/** WebSocket ingress consumes the exact path-bound credential once, then verifies the persisted login proof. */
export const consumeWebSocketTicket = websocketTickets.consume;

/** Auth router assembled for the server entrypoint. */
export const authRoutes = createAuthRouter(authService, authenticateToken);
