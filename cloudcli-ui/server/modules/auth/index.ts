// authRoutes: used by the server entrypoint to mount public authentication endpoints.
export { authRoutes } from './auth.module.js';
// consumeWebSocketTicket: WebSocket ingress exchanges a one-use, path-bound browser ticket for live session proof.
export { consumeWebSocketTicket } from './auth.module.js';

// authenticateToken: used by the server entrypoint to protect authenticated API modules.
export { authenticateToken } from './auth.middleware.js';
// authenticateWebSocket: used by WebSocket setup to verify connection tokens.
export { authenticateWebSocket } from './auth.middleware.js';
// isAuthSessionActive: used by existing WebSocket transports before protected messages and periodic sweeps.
// verifyAuthToken: shared verifier for transport integration tests and any future authenticated transport.
export { isAuthSessionActive, verifyAuthToken } from './auth.middleware.js';
// validateApiKey: used by the server entrypoint for optional API-wide key validation.
export { validateApiKey } from './auth.middleware.js';
