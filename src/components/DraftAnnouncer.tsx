import { Volume2, VolumeX } from 'lucide-react';
import { useViewMode } from '../contexts/ViewContext';
import { useDraftAnnouncer } from '../hooks/useDraftAnnouncer';
import type { DraftState } from '../types';

export function DraftAnnouncer({ draftState }: { draftState?: DraftState }) {
  const announcer = useDraftAnnouncer(draftState, useViewMode());
  if (!announcer.enabled || !draftState) return null;
  return (
    <aside aria-label="Pick announcer" className="fixed bottom-4 left-4 right-4 z-[60] flex items-center justify-end gap-3 pointer-events-none">
      {announcer.caption && (
        <div role="status" className="border border-rule bg-surface px-6 py-4 text-2xl font-semibold text-ink shadow-lg">
          {announcer.caption}
        </div>
      )}
      <button
        onClick={announcer.toggleMuted}
        aria-label={announcer.muted ? 'Unmute pick announcer' : 'Mute pick announcer'}
        aria-pressed={!announcer.muted}
        title={announcer.muted ? 'Unmute pick announcer' : 'Mute pick announcer'}
        className="pointer-events-auto shrink-0 bg-surface text-ink-muted hover:text-ink border border-rule hover:border-rule-strong px-3 py-2 rounded-sharp shadow-lg transition-colors"
      >
        {announcer.muted ? <VolumeX className="w-5 h-5" /> : <Volume2 className="w-5 h-5" />}
      </button>
    </aside>
  );
}
