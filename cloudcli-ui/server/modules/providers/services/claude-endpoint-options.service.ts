import type { Options } from '@anthropic-ai/claude-agent-sdk';

import type { ClaudeEndpointOptions } from '@/shared/types.js';

/** Providers' HiRoute and custom connection services share this override after ordinary SDK mapping. */
export function applyClaudeEndpointOptions(options: Options, endpoint: ClaudeEndpointOptions): void {
  const gatewayEnv = {
    ANTHROPIC_BASE_URL: endpoint.baseUrl,
    ANTHROPIC_AUTH_TOKEN: endpoint.auth.type === 'auth_token' ? endpoint.auth.value : '',
    ANTHROPIC_API_KEY: endpoint.auth.type === 'api_key' ? endpoint.auth.value : '',
    ANTHROPIC_CUSTOM_HEADERS: '',
    CLAUDE_CODE_OAUTH_TOKEN: '',
    CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR: '',
    CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR: '',
    CLAUDE_CODE_USE_BEDROCK: '0', CLAUDE_CODE_USE_VERTEX: '0', CLAUDE_CODE_USE_FOUNDRY: '0',
    ANTHROPIC_MODEL: endpoint.model,
    ANTHROPIC_DEFAULT_OPUS_MODEL: endpoint.model,
    ANTHROPIC_DEFAULT_SONNET_MODEL: endpoint.model,
    ANTHROPIC_DEFAULT_HAIKU_MODEL: endpoint.model,
    ANTHROPIC_SMALL_FAST_MODEL: endpoint.model,
    CLAUDE_CODE_SUBAGENT_MODEL: endpoint.model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  };
  options.env = { ...options.env, ...gatewayEnv };
  // Inline settings override user/project auth while preserving permissions, hooks and session history.
  const settings = typeof options.settings === 'object' ? options.settings : {};
  options.settings = { ...settings, apiKeyHelper: '', model: endpoint.model, env: { ...settings.env, ...gatewayEnv } };
  options.model = endpoint.model;
  delete options.fallbackModel;
  // These Claude-specific controls need not be supported by another Messages endpoint.
  delete options.effort;
  delete options.settings.ultracode;
  delete options.settings.enableWorkflows;
}
