import { useEffect, useRef, useState } from 'react';
import { getAnnouncerStatus, speakAnnouncement } from '../api/client';
import { ViewMode } from '../contexts/ViewContext';
import { DraftPick, DraftState } from '../types';
import { buildAnnouncement, newestAppendedPick, pickSignature } from '../utils/draftAnnouncer';

function readMuted(mode: ViewMode): boolean {
  try {
    const stored = localStorage.getItem(`draft-announcer-muted:${mode}`);
    return stored === null ? mode !== 'public' : stored !== 'false';
  } catch {
    return mode !== 'public';
  }
}

const NO_PICKS: DraftPick[] = [];

export function useDraftAnnouncer(state: DraftState | undefined, mode: ViewMode) {
  const [enabled, setEnabled] = useState(false);
  const [preference, setPreference] = useState(() => ({ mode, muted: readMuted(mode) }));
  const muted = preference.mode === mode ? preference.muted : readMuted(mode);
  const [caption, setCaption] = useState('');
  const previous = useRef(state?.picks ?? NO_PICKS);
  const previousDraft = useRef(state?.divisionId);
  const hadState = useRef(state !== undefined);
  const latest = useRef(state);
  latest.current = state;
  const stop = useRef<() => void>(() => {});
  const signature = pickSignature(state?.picks ?? NO_PICKS);

  useEffect(() => {
    const controller = new AbortController();
    getAnnouncerStatus(controller.signal).then(status => setEnabled(status.enabled === true)).catch(() => {});
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const current = latest.current;
    if (!current) {
      hadState.current = false;
      previous.current = NO_PICKS;
      previousDraft.current = undefined;
      setCaption('');
      return;
    }
    const pick = hadState.current && previousDraft.current === current.divisionId
      ? newestAppendedPick(previous.current, current.picks) : null;
    hadState.current = true;
    previous.current = current.picks;
    previousDraft.current = current.divisionId;
    setCaption('');
    if (!pick || !enabled || muted) return;
    const text = buildAnnouncement(pick, current.teams, current.players);
    if (!text) return;
    const controller = new AbortController();
    let audio: HTMLAudioElement | undefined;
    let url: string | undefined;
    let disposed = false;
    const dispose = () => {
      if (disposed) return;
      disposed = true;
      controller.abort();
      if (audio) {
        audio.onplaying = null;
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      }
      if (url) { URL.revokeObjectURL(url); url = undefined; }
      setCaption('');
    };
    stop.current = dispose;
    speakAnnouncement(text, controller.signal).then(async blob => {
      if (controller.signal.aborted) return;
      url = URL.createObjectURL(blob);
      audio = new Audio(url);
      audio.onplaying = () => { if (!controller.signal.aborted) setCaption(text.replace(/\.$/, '')); };
      audio.onended = dispose;
      audio.onerror = dispose;
      await audio.play();
    }).catch(dispose);
    return dispose;
  }, [signature, state?.divisionId, state !== undefined, enabled, muted, mode]);

  const toggleMuted = () => {
    stop.current();
    const next = !muted;
    setPreference({ mode, muted: next });
    try { localStorage.setItem(`draft-announcer-muted:${mode}`, String(next)); } catch { /* Optional preference. */ }
  };
  return { enabled, muted, toggleMuted, caption };
}
