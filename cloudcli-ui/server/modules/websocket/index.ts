export { WS_OPEN_STATE, connectedClients, getConnectedClientUserId, setConnectedClientUserId } from './services/websocket-state.service.js';
export { createWebSocketServer } from './services/websocket-server.service.js';
export { chatRunRegistry } from './services/chat-run-registry.service.js';
// Consumed by the providers module's sessions watcher, which announces the
// sessions it (re)indexed from disk through the same builder the chat gateway
// uses, so both paths put the identical delta on the wire.
export { broadcastSessionUpserted, broadcastSessionUpsertedBatch } from './services/session-upsert-broadcast.service.js';
// Scheduled messages dispatch without a socket and wait for runtime teardown
// before admitting another queued turn; completion events wake idle queues.
export { handleChatConnection, runDetachedChatTurn, isChatRunInFlight, onChatRunSettled } from './services/chat-websocket.service.js';
export type { ProviderRuntimeGateway } from './services/chat-websocket.service.js';
