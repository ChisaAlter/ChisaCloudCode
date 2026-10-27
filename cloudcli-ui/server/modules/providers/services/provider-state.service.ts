import { createHash } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { sessionsDb } from '@/modules/database/index.js';
import { AppError } from '@/shared/index.js';
import type { LLMProvider } from '@/shared/index.js';

type ManagedProvider = Exclude<LLMProvider, 'claude'>;
const listeners = new Set<(provider: ManagedProvider, home: string) => void>();

/** Provider runners and session readers use a deterministic private HOME per app session; the native host profile is never mounted writable. */
export function managedProviderHome(provider: ManagedProvider, sessionId: string) {
  const identity = createHash('sha256').update(sessionId).digest('hex');
  return path.join(os.homedir(), '.cloudcli', 'provider-runtime', 'profiles', provider, identity, 'state-home');
}
function validate(provider: ManagedProvider, sessionId: string, stored: string) {
  const expected = managedProviderHome(provider, sessionId);
  if (path.resolve(stored) !== expected || (existsSync(expected) && (realpathSync(expected) !== expected || lstatSync(expected).isSymbolicLink()))) throw new AppError('The registered provider profile is not this app session’s private store.', { code: 'WORKSPACE_PROVIDER_PROFILE_INVALID', statusCode: 409 });
  return expected;
}

/** The admitted runtime persists its server-selected profile and informs active watchers; no chat option can register a path. */
export function registerManagedProviderProfile(provider: ManagedProvider, sessionId: string) {
  const home = managedProviderHome(provider, sessionId);
  sessionsDb.setProviderProfilePath(sessionId, home);
  for (const listener of listeners) listener(provider, home);
  return home;
}

/** Provider readers select only a durable session registration or legacy native HOME, preserving external CLI behavior. */
export function resolveProviderHome(provider: ManagedProvider, sessionId?: string | null, registered?: string | null) {
  const row = sessionId ? sessionsDb.getSessionById(sessionId) ?? sessionsDb.getSessionByProviderSessionId(sessionId) : null;
  const stored = registered ?? row?.provider_profile_path;
  return stored && row ? validate(provider, row.session_id, stored) : os.homedir();
}

/** Watchers and native indexers enumerate only registered app-session stores, avoiding an unbounded directory crawl or unknown hash directories. */
export function registeredProviderProfiles(provider?: ManagedProvider) {
  return sessionsDb.listProviderProfiles(provider).map((row) => ({ provider: row.provider as ManagedProvider, home: validate(row.provider as ManagedProvider, row.session_id, row.provider_profile_path) }));
}

/** Artifact indexers preserve the app registration when a managed native transcript is indexed before its runtime event. */
export function profileForArtifact(provider: ManagedProvider, artifact: string) {
  return registeredProviderProfiles(provider).find(({ home }) => path.resolve(artifact).startsWith(home + path.sep))?.home ?? null;
}

/** Session watchers subscribe to new durable registrations so newly started app sessions are observed without restarting the server. */
export function onManagedProviderProfile(listener: (provider: ManagedProvider, home: string) => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
