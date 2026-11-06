import { getAuthSessionSnapshot, isCurrentAuthSession, subscribeToAuthSession } from '@/modules/auth-session';
import { synthesizeVoice, voiceConfigSignature } from '@/shared/api';
import type { AuthSessionSnapshot, VoicePlayState, VoiceSnapshot } from '@/shared/types';

// A single app-level audio player for read-aloud. It owns one <audio> element, lives
// outside the React tree, and caches generated audio by content. Because playback is not
// tied to a component, switching chats or re-rendering a message can't revoke the blob URL
// out from under it (the cause of mid-play cutoffs). v1 plays one message at a time
// (a new play replaces the current one); the design leaves room for a queue later.


const IDLE: VoiceSnapshot = { state: 'idle', error: null };
const CACHE_MAX = 24;
const CLIENT_TIMEOUT_MS = 330000; // backstop; the server proxy already times out at 5 min

// Stable id / cache key from the text and voice settings that affect its audio (djb2).
export function voiceId(content: string, signature = voiceConfigSignature()): string {
  const input = JSON.stringify([content, signature]);
  let h = 5381;
  for (let i = 0; i < input.length; i++) h = (((h << 5) + h) + input.charCodeAt(i)) | 0;
  return (h >>> 0).toString(36);
}

class VoicePlayer {
  private audio: HTMLAudioElement | null = null;
  private unlocked = false;
  private cache = new Map<string, string>(); // id -> blob URL (insertion order = LRU)
  private currentId: string | null = null;
  private state: VoicePlayState = 'idle';
  private errorId: string | null = null;
  private errorMsg: string | null = null;
  private token = 0; // bumps to ignore stale in-flight results
  private activeController: AbortController | null = null; // aborts the in-flight TTS fetch
  private errorTimer: ReturnType<typeof setTimeout> | null = null;
  private listeners = new Set<() => void>();

  constructor() {
    const revoke = () => {
      if (!this.currentSession || isCurrentAuthSession(this.currentSession) && getAuthSessionSnapshot().phase === 'ready') return;
      this.haltPlayback();
      for (const url of this.cache.values()) URL.revokeObjectURL(url);
      this.cache.clear();
      this.currentSession = null;
      this.errorId = null;
      this.errorMsg = null;
      if (this.errorTimer) { clearTimeout(this.errorTimer); this.errorTimer = null; }
      this.emit();
    };
    subscribeToAuthSession(revoke);
  }
  private currentSession: AuthSessionSnapshot | null = null;

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit() {
    this.listeners.forEach((l) => l());
  }

  getSnapshot(id: string): VoiceSnapshot {
    const state = this.currentId === id ? this.state : 'idle';
    const error = this.errorId === id ? this.errorMsg : null;
    if (state === 'idle' && error === null) return IDLE;
    return { state, error };
  }

  private ensureAudio(): HTMLAudioElement {
    if (!this.audio) {
      const audio = new Audio();
      audio.addEventListener('ended', () => this.onEnded());
      audio.addEventListener('error', () => {
        // Only meaningful while we believe we're playing.
        if (this.state === 'playing') this.onEnded();
      });
      this.audio = audio;
    }
    return this.audio;
  }

  // Call synchronously from the click handler so iOS grants the (reused) element playback.
  unlock() {
    if (this.unlocked) return;
    const audio = this.ensureAudio();
    try {
      const p = audio.play();
      if (p && typeof p.catch === 'function') p.catch(() => {});
      audio.pause();
    } catch {
      /* priming attempt; ignore */
    }
    this.unlocked = true;
  }

  toggle(content: string) {
    const session = getAuthSessionSnapshot();
    if (session.phase !== 'ready') return;
    this.currentSession = session;
    const id = voiceId(content);
    if (this.currentId === id && (this.state === 'playing' || this.state === 'loading')) {
      this.stop();
      return;
    }
    void this.play(id, content);
  }

  stop() {
    this.haltPlayback();
    this.emit();
  }

  private haltPlayback() {
    this.token++; // ignore any stale in-flight result
    this.abortActive(); // and actually cancel the network request
    if (this.audio) { this.audio.pause(); this.audio.removeAttribute('src'); this.audio.load(); }
    this.state = 'idle';
    this.currentId = null;
  }

  private abortActive() {
    if (this.activeController) {
      this.activeController.abort();
      this.activeController = null;
    }
  }

  private onEnded() {
    this.state = 'idle';
    this.currentId = null;
    this.emit();
    // (queue auto-advance would hook in here)
  }

  private setError(id: string, msg: string) {
    this.state = 'idle';
    this.currentId = id;
    this.errorId = id;
    this.errorMsg = msg;
    this.emit();
    if (this.errorTimer) clearTimeout(this.errorTimer);
    this.errorTimer = setTimeout(() => {
      if (this.errorId === id) {
        this.errorId = null;
        this.errorMsg = null;
        if (this.currentId === id) this.currentId = null;
        this.emit();
      }
    }, 6000);
  }

  private async play(id: string, content: string) {
    const expected = this.currentSession;
    if (!expected || expected.phase !== 'ready' || !isCurrentAuthSession(expected)) return;
    const audio = this.ensureAudio();
    audio.pause();
    audio.removeAttribute('src');
    audio.load();
    this.currentId = id;
    this.errorId = null;
    this.errorMsg = null;
    this.state = 'loading';
    this.emit();

    const myToken = ++this.token;
    this.abortActive(); // cancel any request this play supersedes
    const controller = new AbortController();
    this.activeController = controller;
    const timer = setTimeout(() => controller.abort(), CLIENT_TIMEOUT_MS);
    const current = () => myToken === this.token && isCurrentAuthSession(expected)
      && getAuthSessionSnapshot().phase === 'ready';
    const verify = () => { controller.signal.throwIfAborted(); return current(); };

    try {
      let url = this.cache.get(id);
      if (url) {
        this.cache.delete(id);
        this.cache.set(id, url);
      } else {
        const res = await synthesizeVoice(content, controller.signal, expected);
        if (!verify()) return;
        if (!res.ok) {
          let msg = `Read-aloud failed (${res.status})`;
          try {
            const j = await res.json();
            if (!verify()) return;
            if (j?.error) msg = String(j.error);
          } catch {
            controller.signal.throwIfAborted();
            if (!current()) return;
            // An unreadable JSON body still uses the response's status message.
          }
          throw new Error(msg);
        }
        const blob = await res.blob();
        if (!verify()) return;
        url = URL.createObjectURL(blob);
        this.cacheSet(id, url);
      }
      if (!verify()) return;
      audio.src = url;
      audio.load();
      await audio.play();
      if (!verify()) return;
      this.state = 'playing';
      this.emit();
    } catch (e) {
      if (!current()) return;
      const aborted = controller.signal.aborted || e instanceof Error && e.name === 'AbortError';
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      this.setError(id, aborted ? 'Read-aloud timed out.' : e instanceof Error ? e.message : 'Read-aloud failed');
    } finally {
      clearTimeout(timer);
      if (this.activeController === controller) this.activeController = null;
    }
  }

  private cacheSet(id: string, url: string) {
    this.cache.set(id, url);
    while (this.cache.size > CACHE_MAX) {
      const oldest = this.cache.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      const oldUrl = this.cache.get(oldest);
      this.cache.delete(oldest);
      if (oldUrl) URL.revokeObjectURL(oldUrl);
    }
  }
}

export const voicePlayer = new VoicePlayer();
