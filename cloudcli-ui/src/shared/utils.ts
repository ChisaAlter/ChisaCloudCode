import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

import type { ComponentBuildIdentity, BlockingOperation, Project, ProjectSession } from '@/shared/types';

//----------------- BLOCKING OPERATIONS ------------

// Creation and background work share this list so overlapping stages finish independently.
let blockingOperations: BlockingOperation[] = [];
const blockingOperationListeners = new Set<() => void>();

/** Used by native capabilities and chat to keep overlapping operations blocked independently. */
export function beginBlockingOperation(title: string, detail: string): () => void {
  return beginOperation(title, detail, true);
}

/** Chat and native synchronization use a status notice without locking the application. */
export function beginBackgroundOperation(title: string, detail: string): () => void {
  return beginOperation(title, detail, false);
}

function beginOperation(title: string, detail: string, blocking: boolean): () => void {
  const id = Symbol(title);
  blockingOperations = [...blockingOperations, { id, title, detail, blocking }];
  blockingOperationListeners.forEach(listener => listener());
  return () => {
    blockingOperations = blockingOperations.filter(operation => operation.id !== id);
    blockingOperationListeners.forEach(listener => listener());
  };
}

/** The shared dialog reads this stable snapshot through useSyncExternalStore. */
export function getBlockingOperations(): BlockingOperation[] { return blockingOperations; }

/** The shared dialog subscribes to operation starts and actual completions without polling. */
export function subscribeBlockingOperations(listener: () => void): () => void {
  blockingOperationListeners.add(listener);
  return () => { blockingOperationListeners.delete(listener); };
}

/** Settings and project entry points use this to hold the dialog across their whole async flow. */
export async function withBlockingOperation<T>(title: string, detail: string, operation: () => Promise<T>): Promise<T> {
  const finish = beginBlockingOperation(title, detail);
  try { return await operation(); }
  finally { finish(); }
}

/** Native operations await real completion while leaving navigation and editing available. */
export async function withBackgroundOperation<T>(title: string, detail: string, operation: () => Promise<T>): Promise<T> {
  const finish = beginBackgroundOperation(title, detail);
  try { return await operation(); }
  finally { finish(); }
}

// ---------------------------

//----------------- DEPLOYMENT MODE ------------

/**
 * Indicates whether the app runs in Platform mode (hosted) or OSS mode (self-hosted).
 * Read it to hide or gate features that only exist in one of the two deployments.
 */
export const IS_PLATFORM = import.meta.env?.VITE_IS_PLATFORM === 'true';

// ---------------------------

//----------------- TAILWIND CLASS COMPOSITION ------------

/**
 * Merges conditional class names and resolves conflicting Tailwind utilities so the
 * last-specified utility wins. Use it for every className built from props or state.
 */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// ---------------------------

//----------------- CLIPBOARD ------------

/**
 * Copies text with `document.execCommand`, the only path that works in browsers or
 * contexts where the async Clipboard API is unavailable. Private to `copyTextToClipboard`.
 */
function fallbackCopyToClipboard(text: string): boolean {
  if (!text || typeof document === 'undefined') {
    return false;
  }

  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';

  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();

  let copied = false;
  try {
    copied = document.execCommand('copy');
  } catch {
    copied = false;
  } finally {
    document.body.removeChild(textarea);
  }

  return copied;
}

/**
 * Copies text to the clipboard, falling back to a hidden textarea when the Clipboard API
 * is blocked. Resolves to whether the copy succeeded so callers can show copied feedback.
 */
export async function copyTextToClipboard(text: string): Promise<boolean> {
  if (!text) {
    return false;
  }

  let copied = false;

  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      copied = true;
    }
  } catch {
    copied = false;
  }

  if (!copied) {
    copied = fallbackCopyToClipboard(text);
  }

  return copied;
}

// ---------------------------

//----------------- NOTIFICATION SOUND ------------

/** localStorage key holding the user's completion-sound preference. Private to the sound helpers. */
const NOTIFICATION_SOUND_ENABLED_STORAGE_KEY = 'notificationSoundEnabled';

/** The browser's AudioContext constructor, including the webkit-prefixed fallback; undefined outside a browser. */
const AudioContextConstructor =
  typeof window !== 'undefined'
    ? window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext
    : undefined;

/** Lazily created and reused, because browsers cap how many AudioContexts a page may open. */
let audioContext: AudioContext | null = null;

/** Reports whether the user has left completion sounds on; defaults to on when unset. */
export const isNotificationSoundEnabled = (): boolean => {
  if (typeof localStorage === 'undefined') {
    return true;
  }

  return localStorage.getItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY) !== 'false';
};

/** Persists the user's completion-sound preference; call it from settings toggles. */
export const setNotificationSoundEnabled = (enabled: boolean): void => {
  if (typeof localStorage === 'undefined') {
    return;
  }

  localStorage.setItem(NOTIFICATION_SOUND_ENABLED_STORAGE_KEY, String(enabled));
};

/** Returns the shared AudioContext, creating it on first use. Private to the sound helpers. */
const getAudioContext = (): AudioContext | null => {
  if (!AudioContextConstructor) {
    return null;
  }

  if (!audioContext) {
    audioContext = new AudioContextConstructor();
  }

  return audioContext;
};

/** Schedules one synthesized sine tone on the shared context. Private to `playNotificationSound`. */
const playTone = (
  context: AudioContext,
  frequency: number,
  startsAt: number,
  duration: number,
  peakVolume: number,
): void => {
  const oscillator = context.createOscillator();
  const gain = context.createGain();

  oscillator.type = 'sine';
  oscillator.frequency.setValueAtTime(frequency, startsAt);

  // Shape the volume so the synthesized tone starts and stops cleanly.
  gain.gain.setValueAtTime(0.0001, startsAt);
  gain.gain.exponentialRampToValueAtTime(peakVolume, startsAt + 0.015);
  gain.gain.exponentialRampToValueAtTime(0.0001, startsAt + duration);

  oscillator.connect(gain);
  gain.connect(context.destination);
  oscillator.start(startsAt);
  oscillator.stop(startsAt + duration + 0.02);
};

/**
 * Plays the two-tone notification chime, honouring the user's preference unless `force`
 * is set (settings previews pass `force` so the user can hear the sound while it is off).
 */
export const playNotificationSound = async ({ force = false } = {}): Promise<void> => {
  if (!force && !isNotificationSoundEnabled()) {
    return;
  }

  const context = getAudioContext();
  if (!context) {
    return;
  }

  try {
    if (context.state === 'suspended') {
      await context.resume();
    }

    const now = context.currentTime;
    playTone(context, 740, now, 0.12, 0.075);
    playTone(context, 988, now + 0.11, 0.16, 0.06);
  } catch (error) {
    // Browsers may block audio until the page receives a user gesture.
    console.warn('Unable to play notification sound:', error);
  }
};

/** Plays the chime for a finished assistant turn; named for the chat call site it serves. */
export const playChatCompletionSound = (options = {}): Promise<void> => playNotificationSound(options);

// ---------------------------

//----------------- DOCUMENT TITLE ------------

/** Browser tab title shown when no project or session is selected. Private to the title helpers. */
const DEFAULT_PAGE_TITLE = 'ChisaCloudCode';

/**
 * Resolves the human-readable label for a session, accounting for Cursor sessions that
 * carry a `name` instead of the summary the other providers return.
 */
export const getSessionTitle = (session: ProjectSession): string => {
  if (session.__provider === 'cursor') {
    return (session.name as string) || 'Untitled Session';
  }

  return (session.summary as string) || 'New Session';
};

/**
 * Builds the browser tab title for the current selection: the session title when one is
 * open, otherwise the project name, otherwise the app name.
 */
export const getPageTitle = (
  selectedProject: Project | null,
  selectedSession: ProjectSession | null,
): string => {
  if (selectedSession) {
    return getSessionTitle(selectedSession);
  }

  const displayName = selectedProject?.displayName?.trim();
  return displayName ? `${displayName} - ${DEFAULT_PAGE_TITLE}` : DEFAULT_PAGE_TITLE;
};

//----------------- COMPONENT BUILD IDENTITY ------------

/** About and diagnostics allow only version metadata; unexpected response content is discarded. */
export function safeBuildIdentity(value: unknown): ComponentBuildIdentity {
  const data = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    version: typeof data.version === 'string' && /^\d+\.\d+\.\d+(?:[-+][A-Za-z0-9.-]+)?$/.test(data.version) ? data.version : null,
    commit: typeof data.commit === 'string' && /^[a-f0-9]{40}$/i.test(data.commit) ? data.commit : null,
    dirty: typeof data.dirty === 'boolean' ? data.dirty : null,
    builtAt: typeof data.builtAt === 'string' && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(data.builtAt) ? data.builtAt : null,
  };
}
