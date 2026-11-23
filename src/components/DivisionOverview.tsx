import { useCallback, useEffect, useRef, useState } from 'react';
import { api, ApiError } from '../api';
import type { Division } from '../types';
import { getDivisionView } from '../utils/divisionAccess';
import { downloadTextFile, generatePublicRosters } from '../utils/exports';
import { DraftBoard } from './DraftBoard';
import { DraftAnnouncer } from './DraftAnnouncer';
import { TeamRosters } from './TeamRosters';

const DRAFT_REFRESH_MS = 5000;

export function DivisionOverview({ initialDivision, onBack }: {
  initialDivision: Division;
  onBack: () => void;
}) {
  const [division, setDivision] = useState(initialDivision);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [refreshError, setRefreshError] = useState<'unavailable' | 'retry' | null>(null);
  const refreshInFlight = useRef(false);
  const view = getDivisionView(division);
  const draft = division.draftState;

  const refresh = useCallback(async () => {
    if (refreshInFlight.current) return;
    refreshInFlight.current = true;
    setIsRefreshing(true);
    try {
      setDivision(await api.getDivision(initialDivision.id));
      setRefreshError(null);
    } catch (error) {
      setRefreshError(error instanceof ApiError && [403, 404].includes(error.status) ? 'unavailable' : 'retry');
    } finally {
      refreshInFlight.current = false;
      setIsRefreshing(false);
    }
  }, [initialDivision.id]);

  useEffect(() => {
    if (view !== 'draft' || refreshError === 'unavailable') return;
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') void refresh();
    }, DRAFT_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [view, refresh, refreshError]);

  return (
    <main className="min-h-screen bg-surface-2 text-ink">
      <DraftAnnouncer draftState={refreshError === 'unavailable' ? undefined : draft ?? undefined} />
      <header className="border-b border-rule bg-surface">
        <div className="mx-auto flex max-w-7xl flex-wrap items-start justify-between gap-4 px-4 py-4">
          <div>
            <button onClick={onBack} className="text-sm text-ink-muted hover:text-ink">
              ← Back to Divisions
            </button>
            <h1 className="mt-1 text-2xl font-bold">{division.name}</h1>
            <p className="text-sm text-ink-muted">
              Read-only · Only league admins can make changes to league rosters.
            </p>
          </div>
          <button
            onClick={refresh}
            disabled={isRefreshing}
            className="rounded-button border border-rule px-3 py-2 text-sm font-medium hover:border-rule-strong disabled:opacity-50"
          >
            {isRefreshing ? 'Refreshing…' : 'Refresh division'}
          </button>
        </div>
      </header>
      {refreshError && (
        <p role="alert" className="mx-auto max-w-7xl px-4 pt-4 text-sm text-alert">
          {refreshError === 'unavailable'
            ? 'This division is no longer available.'
            : "Couldn't refresh this division. The information below may be out of date."}
        </p>
      )}
      {refreshError !== 'unavailable' && (view === 'draft' && draft ? (
        <DraftBoard
          draftState={draft}
          enforceAgeLimit={division.enforceAgeLimit}
          maxPerAge={division.maxPerAge}
        />
      ) : (
        <div className="mx-auto max-w-7xl px-4 py-6">
          {view === 'rosters' ? (
            <>
              <div className="mb-4 flex items-center justify-between gap-4">
                <h2 className="text-xl font-semibold">Team rosters</h2>
                <button
                  onClick={() => {
                    const teams = division.teams.map(team => ({ ...team, roster: [...team.roster] }));
                    downloadTextFile(generatePublicRosters(teams, division.players), `${division.name}-rosters.txt`);
                  }}
                  className="rounded-button border border-rule bg-surface px-3 py-2 text-sm font-medium hover:border-rule-strong"
                >
                  Download rosters
                </button>
              </div>
              <TeamRosters teams={division.teams} currentTeamId={null} showScores={false} />
            </>
          ) : (
            <p className="border border-rule bg-surface px-5 py-4 text-sm text-ink-muted">
              {view === 'draft'
                ? 'The draft board is not available yet. Refresh to check again.'
                : 'The league is still setting up this division. Check back for the draft or team rosters.'}
            </p>
          )}
        </div>
      ))}
    </main>
  );
}
