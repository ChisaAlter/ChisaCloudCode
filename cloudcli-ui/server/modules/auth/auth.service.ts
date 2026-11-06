import { AppError } from '@/shared/index.js';
import type { AuthSessionContext } from '@/shared/index.js';

import { createLoginGuard } from './login-guard.service.js';

// Public non-account hash generated with the same cost as administrator-provisioned cost12 accounts.
const dummyHash = '$2b$12$6pQeeU9zlI4W8Sgq6RHZcO4agYtqmtuCQi9PB/TJisRPD9TXSd4PO';

type AuthUser = {
  id: number | bigint;
  username: string;
  displayName?: string | null;
  avatarDataUrl?: string | null;
};

type AuthLoginUser = AuthUser & { password_hash: string; auth_version: number; is_active?: number; display_name?: string | null; avatar_data_url?: string | null };

type AuthDependencies = {
  users: {
    getUserByUsername(username: string): AuthLoginUser | undefined;
    updateLastLogin(userId: number): void;
    updateProfile(userId: number, displayName: string, avatarDataUrl: string | null): AuthUser | undefined;
  };
  comparePassword(password: string, passwordHash: string): Promise<boolean>;
  generateToken(user: AuthLoginUser): string;
  refreshToken(user: AuthUser, session: AuthSessionContext): string;
  revokeSession(session: AuthSessionContext): void;
  issueWebSocketTicket(session: AuthSessionContext | undefined, path: unknown): { ticket: string; expiresAt: number };
  loginGuard?: ReturnType<typeof createLoginGuard>;
  isPlatform?: boolean;
};

function numericUserId(userId: number | bigint): number {
  return Number(userId);
}

/**
 * Used by auth.module to assemble login, profile, and session behavior around
 * explicit persistence, password verification, and token dependencies.
 */
export function createAuthService(dependencies: AuthDependencies) {
  const loginGuard = dependencies.loginGuard ?? createLoginGuard();
  return {
    getStatus() {
      return {
        isAuthenticated: false,
      };
    },

    async login(usernameInput: unknown, passwordInput: unknown, socketSource = 'unknown') {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED', statusCode: 400,
        });
      }
      if (username.length > 128 || Buffer.byteLength(password, 'utf8') > 72) {
        throw new AppError('Credentials exceed the supported length', { code: 'AUTH_CREDENTIALS_INVALID', statusCode: 400 });
      }
      return loginGuard.run(username, socketSource, async () => {
        const user = dependencies.users.getUserByUsername(username);
        const active = user && user.is_active !== 0;
        // Always consume a bcrypt comparison for an admitted account attempt, including nonexistent/inactive users.
        const validPassword = await dependencies.comparePassword(password, active ? user.password_hash : dummyHash);
        if (!active || !validPassword) {
          throw new AppError('Invalid username or password', { code: 'AUTH_INVALID_CREDENTIALS', statusCode: 401 });
        }
        const token = dependencies.generateToken(user);
        dependencies.users.updateLastLogin(numericUserId(user.id));
        return {
          success: true,
          user: { id: user.id, username: user.username, displayName: user.display_name ?? null, avatarDataUrl: user.avatar_data_url ?? null },
          token,
        };
      });
    },

    getCurrentUser(user: unknown) {
      return { user };
    },

    updateProfile(user: unknown, displayNameInput: unknown, avatarDataUrlInput: unknown) {
      if (typeof user !== 'object' || user === null || !('id' in user)
        || (typeof user.id !== 'number' && typeof user.id !== 'bigint')) {
        throw new AppError('Authenticated user is required', { code: 'AUTH_USER_REQUIRED', statusCode: 401 });
      }
      const displayName = typeof displayNameInput === 'string' ? displayNameInput.trim() : '';
      if (!displayName || displayName.length > 64) {
        throw new AppError('昵称必须为 1–64 个字符', { code: 'PROFILE_NAME_INVALID', statusCode: 400 });
      }
      const avatarDataUrl = avatarDataUrlInput === null ? null : avatarDataUrlInput;
      if (avatarDataUrl !== null) {
        if (typeof avatarDataUrl !== 'string' || !/^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/.test(avatarDataUrl)) {
          throw new AppError('请选择 PNG、JPEG、WebP 或 GIF 头像', { code: 'PROFILE_AVATAR_INVALID', statusCode: 400 });
        }
        const avatarBytes = Buffer.from(avatarDataUrl.slice(avatarDataUrl.indexOf(',') + 1), 'base64');
        if (avatarBytes.length > 2 * 1024 * 1024) {
          throw new AppError('头像不能超过 2 MB', { code: 'PROFILE_AVATAR_TOO_LARGE', statusCode: 400 });
        }
      }
      const savedUser = dependencies.users.updateProfile(Number(user.id), displayName, avatarDataUrl);
      if (!savedUser) {
        throw new AppError('Account was not found', { code: 'AUTH_USER_REQUIRED', statusCode: 401 });
      }
      return { user: savedUser };
    },

    refreshSession(user: unknown, session?: AuthSessionContext) {
      if (
        typeof user !== 'object'
        || user === null
        || !('id' in user)
        || !('username' in user)
        || (typeof user.id !== 'number' && typeof user.id !== 'bigint')
        || typeof user.username !== 'string'
      ) {
        throw new AppError('Authenticated user is required', {
          code: 'AUTH_USER_REQUIRED',
          statusCode: 401,
        });
      }

      if (dependencies.isPlatform && !session) return { token: '' };
      if (!session) throw new AppError('Invalid token', { code: 'AUTH_TOKEN_INVALID', statusCode: 401 });
      return { token: dependencies.refreshToken(user as AuthUser, session) };
    },

    issueWebSocketTicket(session: AuthSessionContext | undefined, path: unknown) {
      return dependencies.issueWebSocketTicket(session, path);
    },

    logout(session?: AuthSessionContext) {
      if (session) dependencies.revokeSession(session);
      else if (!dependencies.isPlatform) throw new AppError('Invalid token', { code: 'AUTH_TOKEN_INVALID', statusCode: 401 });
      return { success: true, message: 'Logged out successfully' };
    },
  };
}
