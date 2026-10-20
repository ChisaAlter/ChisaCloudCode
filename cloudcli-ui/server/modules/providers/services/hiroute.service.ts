import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

import { hirouteDb } from '@/modules/database/index.js';
import type { HiRouteConnection, HiRouteSettings, HiRouteSettingsInput } from '@/shared/types.js';
import { AppError, normalizeClaudeEndpointUrl, normalizeConnectionUserId, requireConnectionUserId } from '@/shared/utils.js';
import { applyClaudeEndpointOptions } from '@/modules/providers/services/claude-endpoint-options.service.js';

const connectionInput = z.object({
  enabled: z.boolean(),
  baseUrl: z.string().trim().max(2048),
  routeModel: z.string().trim().max(256).refine(value => !/[\s\x00-\x1f\x7f]/.test(value), 'Route model must not contain whitespace.'),
  authToken: z.string().trim().max(16384).refine(value => !/[\x00-\x20\x7f]/.test(value), 'Invalid gateway token.').nullable().optional(),
}).strict();

function safeSettings(connection: HiRouteConnection | null): HiRouteSettings {
  return {
    enabled: connection?.enabled ?? false,
    baseUrl: connection?.baseUrl ?? '',
    routeModel: connection?.routeModel ?? '',
    hasAuthToken: Boolean(connection?.authToken),
  };
}

/** Providers routes and Claude runtime use this service to save connections and isolate gateway traffic. */
export const hirouteService = {
  /** Validate the transport payload before passing it to persistence. */
  parseInput(value: unknown): HiRouteSettingsInput {
    const parsed = connectionInput.safeParse(value);
    if (!parsed.success) throw new AppError('Invalid HiRoute settings.', { code: 'INVALID_HIROUTE_SETTINGS', statusCode: 400 });
    return parsed.data;
  },

  getSettings(userId: unknown): HiRouteSettings {
    return safeSettings(hirouteDb.get(requireConnectionUserId(userId)));
  },

  saveSettings(userId: unknown, input: HiRouteSettingsInput): HiRouteSettings {
    const id = requireConnectionUserId(userId);
    const parsed = this.parseInput(input);
    const previous = hirouteDb.get(id);
    const baseUrl = parsed.baseUrl ? normalizeClaudeEndpointUrl(parsed.baseUrl) : '';
    const token = parsed.authToken === null ? '' : parsed.authToken || previous?.authToken || '';
    // A retained grant must not silently follow an edited endpoint to a different server.
    if (token && previous?.baseUrl && baseUrl !== previous.baseUrl && !parsed.authToken) {
      throw new AppError('Re-enter the gateway token when changing its address.', { code: 'HIROUTE_TOKEN_REQUIRED', statusCode: 400 });
    }
    if (parsed.enabled && (!baseUrl || !parsed.routeModel || !token)) {
      throw new AppError('Enabling HiRoute requires a gateway URL, route model, and authorization token.', {
        code: 'HIROUTE_CONFIGURATION_REQUIRED', statusCode: 400,
      });
    }
    const connection = { enabled: parsed.enabled, baseUrl, routeModel: parsed.routeModel, authToken: token };
    hirouteDb.save(id, connection);
    return safeSettings(connection);
  },

  /** Only the authenticated writer selects the connection; client run options never supply grants or user ids. */
  getActiveConnection(userId: unknown): HiRouteConnection | null {
    const id = normalizeConnectionUserId(userId);
    if (!id) return null;
    const connection = hirouteDb.get(id);
    if (!connection?.enabled) return null;
    if (!connection.baseUrl || !connection.routeModel || !connection.authToken) {
      throw new AppError('HiRoute configuration is incomplete.', { code: 'HIROUTE_CONFIGURATION_REQUIRED', statusCode: 400 });
    }
    return connection;
  },

  /** Apply after normal SDK mapping so resume/model defaults cannot override the gateway route. */
  applyToOptions(options: Options, connection: HiRouteConnection | null): void {
    if (!connection) return;
    applyClaudeEndpointOptions(options, { baseUrl: connection.baseUrl, model: connection.routeModel, auth: { type: 'auth_token', value: connection.authToken } });
  },
};
