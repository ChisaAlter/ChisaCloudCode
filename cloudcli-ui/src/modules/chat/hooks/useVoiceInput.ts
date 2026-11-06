import { useCallback, useEffect, useRef, useState } from 'react';

import { getAuthSessionSnapshot, isCurrentAuthSession, subscribeToAuthSession } from '@/modules/auth-session';
import { transcribeVoice } from '@/shared/api';
import type { AuthSessionSnapshot, VoiceInputState } from '@/shared/types';

const MIME_CANDIDATES = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/ogg'];
function pickMime(): string {
  for (const type of MIME_CANDIDATES) {
    try { if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(type)) return type; }
    catch { /* Some mobile browsers reject unsupported MIME probes. */ }
  }
  return '';
}

type Recording = { session: AuthSessionSnapshot; controller: AbortController; stream: MediaStream | null;
  recorder: MediaRecorder | null; chunks: Blob[]; send: boolean };

/** Chat dictation keeps the recording, upload and transcript bound to the account that started the microphone. */
export function useVoiceInput(onTranscript: (text: string, send?: boolean) => void, onError?: (msg: string) => void) {
  // Only the active recording may update status or deliver a transcript.
  const [state, setState] = useState<VoiceInputState>('idle');
  // Pending microphone permission, recorder events and response parsing share one cancellable owner.
  const active = useRef<Recording | null>(null);
  // Async browser callbacks may outlive the composer that requested the microphone.
  const mounted = useRef(true);
  const isActive = (recording: Recording) => mounted.current && active.current === recording
    && !recording.controller.signal.aborted && isCurrentAuthSession(recording.session)
    && getAuthSessionSnapshot().phase === 'ready';
  const releaseTracks = (recording: Recording) => { recording.stream?.getTracks().forEach(track => track.stop()); recording.stream = null; };

  useEffect(() => {
    mounted.current = true;
    const cancel = () => {
      const recording = active.current;
      active.current = null;
      if (recording) {
        recording.controller.abort();
        recording.send = false;
        recording.chunks = [];
        if (recording.recorder) {
          recording.recorder.onstop = null;
          recording.recorder.ondataavailable = null;
          try { if (recording.recorder.state !== 'inactive') recording.recorder.stop(); }
          catch { /* A recorder failure must not prevent account revocation from releasing its tracks. */ }
        }
        releaseTracks(recording);
      }
      if (mounted.current) setState('idle');
    };
    const unsubscribe = subscribeToAuthSession(() => {
      if (active.current && (!isCurrentAuthSession(active.current.session) || getAuthSessionSnapshot().phase !== 'ready')) cancel();
    });
    return () => { mounted.current = false; unsubscribe(); cancel(); };
  }, []);

  const start = useCallback(async () => {
    if (active.current) return;
    const session = getAuthSessionSnapshot();
    if (session.phase !== 'ready') return;
    const recording: Recording = { session, controller: new AbortController(), stream: null, recorder: null, chunks: [], send: false };
    active.current = recording;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
      if (!isActive(recording)) { stream.getTracks().forEach(track => track.stop()); return; }
      recording.stream = stream;
      const mimeType = pickMime();
      const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
      recording.recorder = recorder;
      recorder.ondataavailable = event => { if (isActive(recording) && event.data.size > 0) recording.chunks.push(event.data); };
      recorder.onstop = async () => {
        releaseTracks(recording);
        if (!isActive(recording)) return;
        const shouldSend = recording.send;
        recording.send = false;
        const type = recorder.mimeType || 'audio/webm';
        const blob = new Blob(recording.chunks, { type });
        recording.chunks = [];
        if (blob.size < 800) {
          active.current = null;
          setState('idle');
          onError?.('Recording too short');
          return;
        }
        setState('transcribing');
        try {
          const extension = type.includes('mp4') ? 'm4a' : type.includes('ogg') ? 'ogg' : 'webm';
          const response = await transcribeVoice(blob, `recording.${extension}`, recording.controller.signal, recording.session);
          if (!isActive(recording)) return;
          if (!response.ok) throw new Error(`transcribe ${response.status}`);
          const data = await response.json();
          if (!isActive(recording)) return;
          const text = String(data?.text || '').trim();
          if (text) onTranscript(text, shouldSend);
          else onError?.('No speech detected');
        } catch (error) {
          if (isActive(recording)) onError?.(`Transcription failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
          if (isActive(recording)) { active.current = null; setState('idle'); }
        }
      };
      recorder.start();
      setState('recording');
    } catch (error) {
      releaseTracks(recording);
      if (!isActive(recording)) return;
      active.current = null;
      const failure = error as { name?: string; message?: string };
      onError?.(failure.name === 'NotAllowedError' ? 'Microphone access denied.'
        : failure.name === 'NotFoundError' ? 'No microphone found.' : `Mic error: ${failure.message || error}`);
      setState('idle');
    }
  }, [onTranscript, onError]);

  const stop = useCallback((options?: { send?: boolean }) => {
    const recording = active.current;
    if (recording?.recorder && recording.recorder.state !== 'inactive' && isActive(recording)) {
      recording.send = options?.send ?? false;
      // A browser may queue onstop; release the microphone at the user's stop action.
      try { recording.recorder.stop(); }
      finally { releaseTracks(recording); }
    }
  }, []);
  const toggle = useCallback(() => { if (state === 'recording') stop(); else if (state === 'idle') void start(); }, [state, start, stop]);
  return { state, toggle, stop };
}
