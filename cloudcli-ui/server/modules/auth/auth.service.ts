import { AppError } from '@/shared/index.js';

type AuthUser = {
  id: number | bigint;
  username: string;
  displayName?: string | null;
  avatarDataUrl?: string | null;
};

type AuthLoginUser = AuthUser & { password_hash: string; display_name?: string | null; avatar_data_url?: string | null };

type AuthDependencies = {
  users: {
    getUserByUsername(username: string): AuthLoginUser | undefined;
    updateLastLogin(userId: number): void;
    updateProfile(userId: number, displayName: string, avatarDataUrl: string | null): AuthUser | undefined;
  };
  comparePassword(password: string, passwordHash: string): Promise<boolean>;
  generateToken(user: AuthUser): string;
};

function numericUserId(userId: number | bigint): number {
  return Number(userId);
}

/**
 * Used by auth.module to assemble login, profile, and session behavior around
 * explicit persistence, password verification, and token dependencies.
 */
export function createAuthService(dependencies: AuthDependencies) {
  return {
    getStatus() {
      return {
        isAuthenticated: false,
      };
    },

    async login(usernameInput: unknown, passwordInput: unknown) {
      const username = typeof usernameInput === 'string' ? usernameInput : '';
      const password = typeof passwordInput === 'string' ? passwordInput : '';
      if (!username || !password) {
        throw new AppError('Username and password are required', {
          code: 'AUTH_CREDENTIALS_REQUIRED',
          statusCode: 400,
        });
      }

      const user = dependencies.users.getUserByUsername(username);
      const validPassword = user
        ? await dependencies.comparePassword(password, user.password_hash)
        : false;
      if (!user || !validPassword) {
        throw new AppError('Invalid username or password', {
          code: 'AUTH_INVALID_CREDENTIALS',
          statusCode: 401,
        });
      }

      dependencies.users.updateLastLogin(numericUserId(user.id));
      return {
        success: true,
        user: { id: user.id, username: user.username, displayName: user.display_name ?? null, avatarDataUrl: user.avatar_data_url ?? null },
        token: dependencies.generateToken(user),
      };
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

    refreshSession(user: unknown) {
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

      return { token: dependencies.generateToken(user as AuthUser) };
    },

    logout() {
      return { success: true, message: 'Logged out successfully' };
    },
  };
}
