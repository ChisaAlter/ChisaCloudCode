import { createRequire } from 'node:module';

import { userDb } from '@/modules/database/index.js';

import { authenticateToken, generateToken } from './auth.middleware.js';
import { createAuthRouter } from './auth.routes.js';
import { createAuthService } from './auth.service.js';

type BcryptAdapter = {
  compare(password: string, passwordHash: string): Promise<boolean>;
};

// bcrypt does not ship TypeScript declarations in this project, so the
// composition root narrows its CommonJS runtime surface before injecting it.
const require = createRequire(import.meta.url);
const bcrypt = require('bcrypt') as BcryptAdapter;
const authService = createAuthService({
  users: {
    getUserByUsername: (username) => userDb.getUserByUsername(username),
    updateLastLogin: (userId) => userDb.updateLastLogin(userId),
    updateProfile: (userId, displayName, avatarDataUrl) => userDb.updateProfile(userId, displayName, avatarDataUrl),
  },
  comparePassword: (password, passwordHash) => bcrypt.compare(password, passwordHash),
  generateToken,
});

/** Auth router assembled for the server entrypoint. */
export const authRoutes = createAuthRouter(authService, authenticateToken);
