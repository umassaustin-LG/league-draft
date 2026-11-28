import { useState, useEffect, useRef, useMemo } from 'react';
import {
  Undo,
  ChevronLeft,
  AlertCircle,
  X,
  Users,
  Grid3X3,
  Eye,
  EyeOff,
  Trophy,
} from 'lucide-react';
import { DraftState, Team, DivisionAgeRange, Player, PickWarning, DraftPick } from '../types';
import { getPickWarnings } from '../utils/draftSafety';
import { clearForeignCoachMandatoryPick, canSkipDraftPick, getBestAvailable, getDraftSiblingState } from '../utils/draftLogic';
import { getNextPick, calculateDraftOrder } from '../utils/draftOrder';
import { useViewMode } from '../contexts/ViewContext';
import { VoiceCopilot } from './draft/VoiceCopilot';
import { getTeamDisplayName } from '../utils/teamUtils';
import { DraftBoardPlayerGrid } from './draft/DraftBoardPlayerGrid';
import { DraftBoardRosterView } from './draft/DraftBoardRosterView';

interface DraftControls {
  onDraftPlayer: (playerId: string, options?: { acknowledgeWarnings?: boolean }) => void;
  onSkipPick: () => void;
  onUndo: (expectedPick?: number) => void;
  onReset: () => void;
  pendingComplete: boolean;
  onFinalizeDraft: () => void;
  onCancelComplete: () => void;
}

interface DraftBoardProps {
  draftState: DraftState;
  controls?: DraftControls;
  rosterSize?: number;
  error?: string | null;
  pendingRuleWarnings?: { playerId: string; warnings: PickWarning[] } | null;
  onClearRuleWarnings?: () => void;
  onConfirmOverride?: () => void;
  enforceAgeLimit: boolean;
  maxPerAge: number;
  ageRange?: DivisionAgeRange;
  // Issue #20: isLoading prop to disable buttons during API calls
  isLoading?: boolean;
  // Mandatory pick error modal
  mandatoryPickError?: string | null;
  onClearMandatoryPickError?: () => void;
  // Set only when the signed-in user is a league admin for this division
  voiceCopilotDivisionId?: string;
}

// All scoreboard Zone-2 confirmations flow through a single state.
// The banner voice stays identical regardless of which action is pending.
type PendingAction =
  | { kind: 'draft'; player: Player }
  | { kind: 'skip' }
  | { kind: 'reset' }
  | { kind: 'age-override'; player: Player; currentCount: number };

export const DraftBoard = ({
  draftState: savedDraftState,
  controls: draftControls,
  enforceAgeLimit,
  maxPerAge,
  ageRange,
  rosterSize,
  error,
  pendingRuleWarnings,
  onClearRuleWarnings,
  onConfirmOverride,
  isLoading = false,
  mandatoryPickError,
  onClearMandatoryPickError,
  voiceCopilotDivisionId,
}: DraftBoardProps) => {
  const siblingState = useMemo(() => getDraftSiblingState(
    savedDraftState,
    rosterSize ?? Math.ceil(savedDraftState.players.length / savedDraftState.teams.length),
  ), [savedDraftState, rosterSize]);
  const draftState = clearForeignCoachMandatoryPick({ ...savedDraftState, players: siblingState.players });
  const viewMode = useViewMode();
  const isPublicView = viewMode === 'public';
  const controls = isPublicView ? undefined : draftControls;
  const canRunDraft = !!controls;

  const [drawerMode, setDrawerMode] = useState<'players' | 'rosters' | 'history'>('players');
  const [ruleDialog, setRuleDialog] = useState<{ playerId: string; warnings: PickWarning[] } | null>(null);
  const [overrideAccepted, setOverrideAccepted] = useState(false);
  const [undoPick, setUndoPick] = useState<DraftPick | null>(null);
  const [scoresEnabled, setScoresEnabled] = useState(true);
  const showScores = !isPublicView && scoresEnabled;
  const [showRoundInterstitial, setShowRoundInterstitial] = useState(false);
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(null);
  const [interstitialData, setInterstitialData] = useState<{
    completedRound: number;
    nextRound: number;
    newOrder: Array<{ team: Team; position: number; score: number }>;
  } | null>(null);
  const previousRoundRef = useRef(draftState.currentRound);

  useEffect(() => {
    if (canRunDraft && draftState.currentRound > previousRoundRef.current && draftState.currentRound > 1) {
      const newOrder = draftState.currentRoundOrder.map((teamId, index) => {
        const team = draftState.teams.find(t => t.id === teamId)!;
        return {
          team,
          position: index + 1,
          score: team.totalScore,
        };
      });

      setInterstitialData({
        completedRound: previousRoundRef.current,
        nextRound: draftState.currentRound,
        newOrder,
      });
      setShowRoundInterstitial(true);
    }
    previousRoundRef.current = draftState.currentRound;
  }, [canRunDraft, draftState.currentRound, draftState.currentRoundOrder, draftState.teams]);

  const availablePlayers = draftState.players.filter((p) => !p.isDrafted);

  const derivedCurrentTeamId = draftState.currentTeamId ||
    draftState.currentRoundOrder[draftState.currentPickInRound - 1] || null;
  const currentTeam = draftState.teams.find((t) => t.id === derivedCurrentTeamId);
  const warningsByPlayer: Record<string, PickWarning[]> = {};
  if (currentTeam) availablePlayers.forEach(player => {
    warningsByPlayer[player.id] = getPickWarnings(player, currentTeam, draftState.players, draftState.picks, {
      enforceAgeLimit, maxPerAge, ageRange: ageRange ?? { min: 0, max: 99 },
      rosterSize: rosterSize ?? Math.ceil(draftState.players.length / draftState.teams.length),
      teamCount: draftState.teams.length,
      teams: draftState.teams,
    }, draftState.mandatoryPick?.playerId);
  });
  const activeRuleDialog = pendingRuleWarnings ?? ruleDialog;
  const requestDraft = (playerId: string) => {
    const warnings = warningsByPlayer[playerId] ?? [];
    if (warnings.length) {
      setOverrideAccepted(false);
      setRuleDialog({ playerId, warnings });
    } else {
      const player = draftState.players.find(p => p.id === playerId);
      if (player) setPendingAction({ kind: 'draft', player });
    }
  };
  const requestUndo = () => setUndoPick(draftState.picks[draftState.picks.length - 1] ?? null);
  const undoDescription = undoPick ? (undoPick.wasSkipped || !undoPick.playerId
    ? `Undo skipped pick #${undoPick.pick}`
    : `Undo pick #${undoPick.pick}: ${draftState.players.find(p => p.id === undoPick.playerId)?.name ?? 'Unknown player'} → ${(() => { const team = draftState.teams.find(t => t.id === undoPick.teamId); return team ? getTeamDisplayName(team) : 'Unknown team'; })()}`) : '';
  useEffect(() => { setOverrideAccepted(false); }, [pendingRuleWarnings]);

  const { round: nextRound, pickInRound: nextPickInRound } = getNextPick(
    draftState.currentRound,
    draftState.currentPickInRound,
    draftState.teams.length
  );

  let nextTeamId: string | null = null;
  if (nextRound === draftState.currentRound) {
    nextTeamId = draftState.currentRoundOrder[nextPickInRound - 1] || null;
  } else {
    const previewNextRoundOrder = calculateDraftOrder(
      draftState.teams,
      nextRound,
      draftState.draftFormat,
      draftState.draftOrder
    );
    nextTeamId = previewNextRoundOrder[0] || null;
  }

  const nextTeam = draftState.teams.find((t) => t.id === nextTeamId);

  const totalRounds = rosterSize ?? Math.ceil(draftState.players.length / draftState.teams.length);
  const totalPicks = draftState.teams.length * totalRounds;
  const currentPickNumber = (draftState.currentRound - 1) * draftState.teams.length + draftState.currentPickInRound;
  const isFinalRound = draftState.currentRound === totalRounds;

  const remainingSpots = totalPicks - draftState.picks.length;
  const canSkip = !!draftState.currentTeamId && canSkipDraftPick(draftState.players, draftState.currentTeamId, remainingSpots, draftState.mandatoryPick?.playerId);
  const pickCandidates = draftState.mandatoryPick
    ? draftState.players.filter(player => player.id === draftState.mandatoryPick!.playerId)
    : draftState.players;

  const handleRequestSkip = () => {
    if (!currentTeam || !canSkip) return;
    setPendingAction({ kind: 'skip' });
  };

  const handleRequestReset = () => {
    setPendingAction({ kind: 'reset' });
  };

  const handleConfirmPending = () => {
    if (!controls || !pendingAction || activeRuleDialog || undoPick) return;
    switch (pendingAction.kind) {
      case 'draft':
        controls.onDraftPlayer(pendingAction.player.id);
        break;
      case 'age-override':
        controls.onDraftPlayer(pendingAction.player.id);
        break;
      case 'skip':
        controls.onSkipPick();
        break;
      case 'reset':
        controls.onReset();
        break;
    }
    setPendingAction(null);
  };

  const handleCancelPending = () => {
    setPendingAction(null);
  };

  // Clear any pending confirmation when the draft advances or completes.
  useEffect(() => {
    setPendingAction(null);
  }, [draftState.currentTeamId, draftState.isDraftComplete]);

  // Global keyboard shortcuts for admins running the draft at speed.
  // Escape cancels any pending confirmation, Enter confirms, Cmd/Ctrl-Z undoes.
  useEffect(() => {
    if (!controls) return;

    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      if (e.key === 'Escape' && pendingAction) {
        e.preventDefault();
        e.stopPropagation();
        setPendingAction(null);
        return;
      }

      if (e.key === 'Enter' && !isTyping && pendingAction && !isLoading) {
        e.preventDefault();
        e.stopPropagation();
        handleConfirmPending();
        return;
      }

      if (
        (e.metaKey || e.ctrlKey) &&
        !e.shiftKey &&
        (e.key === 'z' || e.key === 'Z') &&
        !isTyping &&
        !pendingAction &&
        !activeRuleDialog &&
        !undoPick &&
        !isLoading &&
        draftState.picks.length > 0
      ) {
        e.preventDefault();
        requestUndo();
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [controls, pendingAction, isLoading, draftState.picks.length, activeRuleDialog, undoPick]);

  // Zone 2 default (On deck) only shows when nothing else is claiming the slot.
  const showQuickPicks = canRunDraft && !draftState.mandatoryPick && !pendingAction;

  const mandatoryPlayerForScoreboard = draftState.mandatoryPick
    ? draftState.players.find((p) => p.id === draftState.mandatoryPick?.playerId)
    : undefined;

  // Build the Zone 2 banner content from whichever state is active.
  // Falls through to On-Deck when nothing's pending.
  const zone2 = (() => {
    if (draftState.mandatoryPick && !pendingAction && controls) {
      return {
        label: 'Mandatory pick',
        labelIcon: <AlertCircle className="w-3 h-3" />,
        labelTone: 'alert' as const,
        headline: mandatoryPlayerForScoreboard?.name ?? '',
        detail:
          draftState.mandatoryPick.reason === 'coach-kid'
            ? "Coach's kid"
            : draftState.mandatoryPick.siblingName
              ? `Sibling of ${draftState.mandatoryPick.siblingName}`
              : 'Linked sibling',
        primaryLabel: 'Draft',
        onPrimary: () =>
          mandatoryPlayerForScoreboard && requestDraft(mandatoryPlayerForScoreboard.id),
        cancellable: false,
      };
    }

    if (pendingAction && canRunDraft) {
      switch (pendingAction.kind) {
        case 'draft':
          return {
            label: 'Confirm pick',
            labelTone: 'default' as const,
            headline: pendingAction.player.name,
            detail: `${pendingAction.player.totalScore.toFixed(1)} pts`,
            detailMono: true,
            primaryLabel: 'Draft',
            onPrimary: handleConfirmPending,
            cancellable: true,
          };
        case 'age-override':
          return {
            label: 'Age limit reached',
            labelIcon: <AlertCircle className="w-3 h-3" />,
            labelTone: 'warn' as const,
            headline: pendingAction.player.name,
            detail: `Team already has ${pendingAction.currentCount} age-${pendingAction.player.littleLeagueAge} players (limit ${maxPerAge})`,
            primaryLabel: 'Draft anyway',
            onPrimary: handleConfirmPending,
            cancellable: true,
          };
        case 'skip':
          return {
            label: 'Skip this pick?',
            labelTone: 'warn' as const,
            headline: currentTeam ? getTeamDisplayName(currentTeam) : 'Current team',
            detail: 'Team will finish with one fewer player',
            primaryLabel: 'Skip pick',
            onPrimary: handleConfirmPending,
            cancellable: true,
          };
        case 'reset':
          return {
            label: 'Reset draft?',
            labelIcon: <AlertCircle className="w-3 h-3" />,
            labelTone: 'alert' as const,
            headline: 'Clear all picks',
            detail: "Teams and players are preserved · you'll return to setup",
            primaryLabel: 'Reset draft',
            onPrimary: handleConfirmPending,
            cancellable: true,
          };
      }
    }

    return null;
  })();

  return (
    <div className="min-h-screen bg-surface p-4">
      {error && !isPublicView && <p role="alert" className="bg-alert-soft text-alert border border-alert p-3 mb-4 rounded-sharp">{error}</p>}
      {activeRuleDialog && controls && <Modal maxWidth="md" onDismiss={isLoading ? undefined : () => { setRuleDialog(null); onClearRuleWarnings?.(); }}>
        <div className="p-6 text-ink">
          <h2 className="text-xl font-semibold mb-2">Confirm pick: {draftState.players.find(p => p.id === activeRuleDialog.playerId)?.name}</h2>
          <ul className="space-y-3 my-4">{activeRuleDialog.warnings.map((warning, i) => <li key={i} className={`flex gap-2 text-sm ${warning.level === 'block' ? 'text-alert' : 'text-warn'}`}><AlertCircle className="w-4 h-4 shrink-0 mt-0.5" /><span>{warning.message}</span></li>)}</ul>
          {activeRuleDialog.warnings.some(w => w.level === 'block') && <label className="flex gap-2 text-sm mb-5"><input type="checkbox" checked={overrideAccepted} onChange={e => setOverrideAccepted(e.target.checked)} />I understand this breaks a league rule</label>}
          <div className="flex justify-end gap-3">
            <button disabled={isLoading} onClick={() => { setRuleDialog(null); onClearRuleWarnings?.(); }} className="px-4 py-2 border border-rule rounded-button">Cancel</button>
            <button disabled={isLoading || (activeRuleDialog.warnings.some(w => w.level === 'block') && !overrideAccepted)} onClick={() => {
              if (pendingRuleWarnings) onConfirmOverride?.();
              else controls.onDraftPlayer(activeRuleDialog.playerId, { acknowledgeWarnings: true });
              setRuleDialog(null);
            }} className="px-4 py-2 bg-brand text-white rounded-button disabled:opacity-40">{activeRuleDialog.warnings.some(w => w.level === 'block') ? 'Override and draft' : 'Draft'}</button>
          </div>
        </div>
      </Modal>}
      {undoPick && controls && <Modal maxWidth="md" onDismiss={() => setUndoPick(null)}><div className="p-6 text-ink"><h2 className="text-xl font-semibold mb-4">{undoDescription}</h2><p className="text-sm text-ink-muted mb-5">This action remains in draft history.</p><div className="flex justify-end gap-3"><button className="border border-rule px-4 py-2 rounded-button" onClick={() => setUndoPick(null)}>Cancel</button><button className="bg-brand text-white px-4 py-2 rounded-button" disabled={isLoading} onClick={() => { controls.onUndo(undoPick.pick); setUndoPick(null); }}>Undo pick</button></div></div></Modal>}
      {/* Round Completion Interstitial Modal */}
      {showRoundInterstitial && interstitialData && (
        <Modal onDismiss={() => setShowRoundInterstitial(false)} maxWidth="lg">
          <div className="px-6 py-5 border-b border-rule">
            <div className="font-mono text-[11px] uppercase tracking-label text-ink-faint mb-2">
              Round {interstitialData.completedRound} complete
            </div>
            <h2 className="font-black text-3xl leading-tight tracking-score text-ink">
              Round {interstitialData.nextRound} order
            </h2>
          </div>

          <div className="px-6 py-4">
            <div className="divide-y divide-rule">
              {interstitialData.newOrder.map(({ team, position, score }) => (
                <div
                  key={team.id}
                  className="flex items-center gap-4 py-2.5"
                >
                  <span className="font-mono text-xs tabular-nums text-ink-faint w-6 text-right">
                    {String(position).padStart(2, '0')}
                  </span>
                  <span className="flex-1 text-sm font-semibold text-ink truncate">
                    {getTeamDisplayName(team)}
                  </span>
                  <span className="font-mono text-xs tabular-nums text-ink-muted">
                    {score.toFixed(1)}
                  </span>
                </div>
              ))}
            </div>

            {draftState.draftFormat === 'recalculated' && (
              <p className="mt-4 font-mono text-[11px] uppercase tracking-label text-ink-faint">
                Recalculated · lowest-scoring team picks first
              </p>
            )}
            {draftState.draftFormat === 'snake' && (
              <p className="mt-4 font-mono text-[11px] uppercase tracking-label text-ink-faint">
                Snake · order reversed from previous round
              </p>
            )}
          </div>

          <div className="px-6 py-4 border-t border-rule flex justify-end">
            <button
              onClick={() => setShowRoundInterstitial(false)}
              className="bg-brand hover:bg-brand-strong text-white text-xs font-semibold uppercase tracking-button px-5 py-2.5 rounded-button transition-colors"
            >
              Continue to Round {interstitialData.nextRound}
            </button>
          </div>
        </Modal>
      )}

      <div className="max-w-7xl mx-auto">
        {siblingState.released.length > 0 && (
          <div role="status" className="mb-4 border border-rule bg-surface p-4 text-ink">
            Sibling rule could not be honored for {siblingState.released.map(player => player.name).join(', ')}:
            {' '}their sibling’s team does not have enough picks left. They may be drafted by another team; coach assignments still apply.
          </div>
        )}
        {/* Sticky scoreboard — current pick (hero) | on-deck OR mandatory OR pending | admin */}
        <div className={`sticky ${canRunDraft ? 'top-10' : 'top-0'} z-40 -mx-4 px-4 pt-0 pb-4 bg-surface`}>
          <section className="bg-surface border border-rule rounded-sharp">
            <div className="grid grid-cols-[1.2fr_1.3fr_auto] gap-x-8 items-start px-6 py-5">

              {/* Zone 1 — current pick */}
              <div className="min-w-0">
                {currentTeam ? (
                  <>
                    <div className="font-mono text-[11px] uppercase tracking-label text-ink-muted mb-2">
                      Round {draftState.currentRound} · Pick {currentPickNumber} of {totalPicks}
                    </div>
                    <h1
                      className="font-black text-5xl leading-[0.95] tracking-score text-ink mb-3 truncate"
                      title={getTeamDisplayName(currentTeam)}
                    >
                      {getTeamDisplayName(currentTeam)}
                    </h1>
                    {enforceAgeLimit && maxPerAge > 0 && Object.keys(currentTeam.ageBreakdown || {}).length > 0 && (
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <span className="font-mono text-[10px] uppercase tracking-label text-ink-faint mr-1">
                          Ages
                        </span>
                        {Object.entries(currentTeam.ageBreakdown || {})
                          .sort(([a], [b]) => Number(a) - Number(b))
                          .map(([age, count]) => {
                            const isFull = count >= maxPerAge;
                            const isNear = !isFull && count >= maxPerAge - 1;
                            return (
                              <span
                                key={age}
                                className={`font-mono text-[11px] tabular-nums px-1.5 py-0.5 border rounded-sharp ${
                                  isFull
                                    ? 'border-alert text-alert'
                                    : isNear
                                    ? 'border-warn text-ink'
                                    : 'border-rule text-ink-muted'
                                }`}
                                title={`Age ${age}: ${count} of ${maxPerAge}`}
                              >
                                {age}:{count}
                              </span>
                            );
                          })}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="text-ink-faint text-sm">No current team</div>
                )}
              </div>

              {/* Zone 2 — on-deck OR mandatory OR pending (mutually exclusive) */}
              <div className="min-w-0 border-l border-rule pl-8">
                {zone2 ? (
                  <ConfirmBanner
                    label={zone2.label}
                    labelIcon={zone2.labelIcon}
                    labelTone={zone2.labelTone}
                    headline={zone2.headline}
                    detail={zone2.detail}
                    detailMono={zone2.detailMono}
                    primaryLabel={zone2.primaryLabel}
                    onPrimary={zone2.onPrimary}
                    cancellable={zone2.cancellable}
                    onCancel={handleCancelPending}
                    isLoading={isLoading}
                  />
                ) : (
                  <>
                    <div className="font-mono text-[11px] uppercase tracking-label text-ink-faint mb-2">
                      On deck
                    </div>
                    <div className="text-2xl font-semibold text-ink-muted truncate">
                      {nextTeam ? getTeamDisplayName(nextTeam) : '—'}
                    </div>
                  </>
                )}
              </div>

              {/* Zone 3 — admin / live */}
              <div className="flex items-start gap-1">
                {controls ? (
                  <>
                    {(isFinalRound || !getBestAvailable(pickCandidates, derivedCurrentTeamId ?? undefined)) && (
                      <button
                        onClick={handleRequestSkip}
                        disabled={!canSkip || isLoading || !!pendingAction}
                        className="text-[11px] uppercase tracking-button font-semibold text-ink-muted hover:text-ink border border-rule hover:border-rule-strong px-3 py-1.5 rounded-sharp disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                        title={canSkip ? "Skip this team's pick" : 'Cannot skip — all remaining players must be drafted'}
                      >
                        Skip
                      </button>
                    )}
                    <button
                      onClick={requestUndo}
                      disabled={draftState.picks.length === 0 || isLoading || !!pendingAction}
                      className="text-[11px] uppercase tracking-button font-semibold text-ink-muted hover:text-ink border border-rule hover:border-rule-strong px-3 py-1.5 rounded-sharp flex items-center gap-1.5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      title="Undo last pick · ⌘Z"
                    >
                      <Undo className="w-3 h-3" />
                      Undo
                    </button>
                    <button
                      onClick={handleRequestReset}
                      disabled={isLoading || !!pendingAction}
                      className="text-[11px] uppercase tracking-button font-semibold text-ink-muted hover:text-ink border border-rule hover:border-rule-strong px-3 py-1.5 rounded-sharp flex items-center gap-1.5 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                      title="Return to draft setup"
                    >
                      <ChevronLeft className="w-3 h-3" />
                      Reset
                    </button>
                  </>
                ) : (
                  <div className="font-mono text-[11px] uppercase tracking-label text-brand border border-brand px-2.5 py-1 rounded-sharp">
                    Read-only
                  </div>
                )}
              </div>
            </div>
          </section>
        </div>

        {/* Round order strip */}
        <div className="bg-surface border border-rule rounded-sharp px-5 py-4 mt-4 mb-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="font-mono text-[11px] uppercase tracking-label text-ink-muted">
              Round {draftState.currentRound} order
            </h3>
            <span className="font-mono text-[11px] uppercase tracking-label text-ink-faint">
              {draftState.draftFormat}
            </span>
          </div>
          <div className="flex flex-wrap gap-2">
            {draftState.currentRoundOrder.map((teamId, index) => {
              const team = draftState.teams.find((t) => t.id === teamId);
              const isPastPick = index + 1 < draftState.currentPickInRound;
              const isCurrentPick = index + 1 === draftState.currentPickInRound;

              return (
                <div
                  key={teamId}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-sharp border transition-colors ${
                    isCurrentPick
                      ? 'border-brand bg-brand-soft'
                      : isPastPick
                      ? 'border-rule bg-surface-2 opacity-50'
                      : 'border-rule bg-surface'
                  }`}
                >
                  <span
                    className={`font-mono text-[11px] tabular-nums tracking-label ${
                      isCurrentPick
                        ? 'text-brand'
                        : isPastPick
                        ? 'text-ink-faint'
                        : 'text-ink-muted'
                    }`}
                  >
                    {String(index + 1).padStart(2, '0')}
                  </span>
                  <span
                    className={`text-sm font-semibold ${
                      isCurrentPick
                        ? 'text-ink'
                        : isPastPick
                        ? 'text-ink-faint line-through'
                        : 'text-ink'
                    }`}
                  >
                    {team ? getTeamDisplayName(team) : 'Unknown'}
                  </span>
                  {isCurrentPick && (
                    <span className="font-mono text-[10px] uppercase tracking-label text-brand pl-2 ml-1 border-l border-rule-strong">
                      Now
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>

        {voiceCopilotDivisionId && !isPublicView && (
          <VoiceCopilot
            draftState={draftState}
            divisionId={voiceCopilotDivisionId}
            screen={drawerMode}
            rules={{ enforceAgeLimit, maxPerAge }}
          />
        )}

        {/* Drawer toggle */}
        <div className="flex items-center justify-between bg-surface border border-rule rounded-sharp px-3 py-2 mb-4">
          <div className="flex gap-1">
            <button
              onClick={() => setDrawerMode('players')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-sharp text-xs font-semibold uppercase tracking-button transition-colors ${
                drawerMode === 'players'
                  ? 'bg-ink text-surface'
                  : 'text-ink-muted hover:text-ink'
              }`}
            >
              <Grid3X3 className="w-3.5 h-3.5" />
              Players
              <span className={`font-mono text-[10px] tabular-nums px-1 py-0.5 rounded-sharp ${
                drawerMode === 'players' ? 'bg-surface text-ink' : 'bg-surface-2 text-ink-muted'
              }`}>
                {availablePlayers.length}
              </span>
            </button>
            <button
              onClick={() => setDrawerMode('rosters')}
              className={`flex items-center gap-2 px-3 py-1.5 rounded-sharp text-xs font-semibold uppercase tracking-button transition-colors ${
                drawerMode === 'rosters'
                  ? 'bg-ink text-surface'
                  : 'text-ink-muted hover:text-ink'
              }`}
            >
              <Users className="w-3.5 h-3.5" />
              Rosters
            </button>
            <button onClick={() => setDrawerMode('history')} className={`px-3 py-1.5 rounded-sharp text-xs font-semibold uppercase tracking-button ${drawerMode === 'history' ? 'bg-ink text-surface' : 'text-ink-muted hover:text-ink'}`}>History</button>
          </div>

          {!isPublicView && <button
            onClick={() => setScoresEnabled(enabled => !enabled)}
            className={`flex items-center gap-2 px-3 py-1.5 rounded-sharp text-xs font-semibold uppercase tracking-button transition-colors ${
              showScores ? 'text-ink' : 'text-ink-muted hover:text-ink'
            }`}
            title={showScores ? 'Hide scores (presentation mode)' : 'Show scores'}
          >
            {showScores ? (
              <>
                <Eye className="w-3.5 h-3.5" />
                Scores on
              </>
            ) : (
              <>
                <EyeOff className="w-3.5 h-3.5" />
                Scores hidden
              </>
            )}
          </button>}
        </div>

        {/* Drawer Content */}
        <div className="overflow-auto">
          {drawerMode === 'players' ? (
            <DraftBoardPlayerGrid
              players={draftState.players}
              currentTeamId={derivedCurrentTeamId}
              teams={draftState.teams}
              showScores={showScores}
              onDraftPlayer={canRunDraft ? requestDraft : undefined}
              warningsByPlayer={warningsByPlayer}
              mandatoryPick={draftState.mandatoryPick}
              isLoading={isLoading}
              enforceAgeLimit={enforceAgeLimit}
              maxPerAge={maxPerAge}
              currentTeamAgeBreakdown={currentTeam?.ageBreakdown || {}}
              isReadOnly={!canRunDraft}
              onQuickPick={showQuickPicks ? (player) => requestDraft(player.id) : undefined}
              onAgeOverrideNeeded={canRunDraft ? (player) => requestDraft(player.id) : undefined}
            />
          ) : drawerMode === 'history' ? (
            <section aria-label="Draft history" className="bg-surface border border-rule rounded-sharp text-ink divide-y divide-rule">
              {!(draftState.auditLog?.length) && <p className="p-5 text-ink-muted">No draft history yet.</p>}
              {[...(draftState.auditLog ?? [])].reverse().map(event => {
                const player = draftState.players.find(p => p.id === event.playerId);
                const team = draftState.teams.find(t => t.id === event.teamId);
                const tradePlayers = event.action === 'trade' ? [event.details.player1_id, event.details.player2_id].map(id => draftState.players.find(p => p.id === id)?.name ?? 'Unknown player').join(' ↔ ') : null;
                const tradeTeams = event.action === 'trade' ? [event.details.team1_id, event.details.team2_id].map(id => { const t = draftState.teams.find(t => t.id === id); return t ? getTeamDisplayName(t) : 'Unknown team'; }).join(' ↔ ') : null;
                return <div key={event.id} className="p-4 flex flex-wrap items-center gap-3 text-sm">
                  <time className="font-mono text-xs text-ink-muted" dateTime={event.timestamp}>{new Date(event.timestamp).toLocaleTimeString()}</time>
                  <span className="uppercase font-semibold text-xs">{event.action}</span>
                  {event.pick != null && <span className="font-mono">Pick #{event.pick}</span>}
                  {player && <span>{player.name}</span>}{team && <span>→ {getTeamDisplayName(team)}</span>}
                  {tradePlayers && <span>{tradePlayers} · {tradeTeams}</span>}
                  {!isPublicView && event.actorName && <span className="text-ink-muted">by {event.actorName}</span>}
                  {Array.isArray(event.details.overridden_warnings) && event.details.overridden_warnings.length > 0 && <span className="text-alert border border-alert rounded-sharp px-2 py-0.5 text-xs">rule override</span>}
                </div>;
              })}
            </section>
          ) : (
            <DraftBoardRosterView
              teams={draftState.teams}
              players={draftState.players}
              draftOrder={draftState.draftOrder}
              currentRound={draftState.currentRound}
              currentPickInRound={draftState.currentPickInRound}
              currentRoundOrder={draftState.currentRoundOrder}
              showScores={showScores}
              totalRounds={totalRounds}
              isPublicView={isPublicView}
            />
          )}
        </div>
      </div>

      {/* Mandatory Pick Error Modal */}
      {controls && mandatoryPickError && draftState.mandatoryPick && (() => {
        const mandatoryPlayer = draftState.players.find(p => p.id === draftState.mandatoryPick?.playerId);
        const reason = draftState.mandatoryPick.reason === 'coach-kid' ? "Coach's kid" : 'Sibling requirement';

        return (
          <Modal onDismiss={onClearMandatoryPickError} maxWidth="md">
            <div className="px-6 py-5 border-b border-rule">
              <div className="flex items-start gap-3">
                <AlertCircle className="w-5 h-5 text-alert flex-shrink-0 mt-1" />
                <div>
                  <div className="font-mono text-[11px] uppercase tracking-label text-alert mb-1">
                    Mandatory pick required
                  </div>
                  <h3 className="font-black text-2xl leading-tight tracking-score text-ink">
                    {mandatoryPlayer?.name}
                  </h3>
                  <p className="font-mono text-[11px] uppercase tracking-label text-ink-muted mt-1">
                    {reason}
                  </p>
                </div>
              </div>
            </div>

            {mandatoryPlayer && (
              <div className="px-6 py-4 border-b border-rule bg-surface-2">
                <div className="flex items-center justify-between gap-4">
                  <dl className="flex items-center gap-6 font-mono text-xs tabular-nums text-ink-muted">
                    <div>
                      <dt className="uppercase text-[10px] tracking-label text-ink-faint">Bib</dt>
                      <dd className="text-ink">{mandatoryPlayer.bib}</dd>
                    </div>
                    <div>
                      <dt className="uppercase text-[10px] tracking-label text-ink-faint">Age</dt>
                      <dd className="text-ink">{mandatoryPlayer.littleLeagueAge}</dd>
                    </div>
                    <div>
                      <dt className="uppercase text-[10px] tracking-label text-ink-faint">Rank</dt>
                      <dd className="text-ink">#{mandatoryPlayer.rank}</dd>
                    </div>
                  </dl>
                  <div className="text-right">
                    <div className="font-mono text-[10px] uppercase tracking-label text-ink-faint">Score</div>
                    <div className="font-mono text-2xl font-semibold tabular-nums text-ink">
                      {mandatoryPlayer.totalScore.toFixed(1)}
                    </div>
                  </div>
                </div>
              </div>
            )}

            <div className="px-6 py-4 flex justify-end gap-2">
              <button
                onClick={onClearMandatoryPickError}
                className="text-xs font-semibold uppercase tracking-button text-ink-muted hover:text-ink border border-rule hover:border-rule-strong px-4 py-2 rounded-button transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={() => {
                  if (mandatoryPlayer) {
                    onClearMandatoryPickError?.();
                    requestDraft(mandatoryPlayer.id);
                  }
                }}
                disabled={isLoading}
                className="bg-brand hover:bg-brand-strong text-white text-xs font-semibold uppercase tracking-button px-4 py-2 rounded-button disabled:opacity-50 transition-colors"
              >
                {isLoading ? 'Drafting…' : 'Draft player'}
              </button>
            </div>
          </Modal>
        );
      })()}

      {/* Draft Complete Confirmation Modal */}
      {controls?.pendingComplete && (
        <Modal onDismiss={isLoading ? undefined : controls.onCancelComplete} maxWidth="md">
          <div className="px-6 py-6 min-h-0 overflow-y-auto">
            <div className="flex items-start gap-3 mb-4">
              <Trophy className="w-6 h-6 text-brand flex-shrink-0 mt-0.5" />
              <div>
                <div className="font-mono text-[11px] uppercase tracking-label text-ink-faint mb-1">
                  All picks made
                </div>
                <h2 className="font-black text-3xl leading-tight tracking-score text-ink">
                  Draft complete
                </h2>
              </div>
            </div>
            <p className="text-sm text-ink-muted max-w-[48ch]">
              All <span className="font-mono tabular-nums text-ink">{draftState.picks.length}</span> picks
              have been recorded. Finalize to lock in rosters and unlock exports.
            </p>
            <p className="mt-3 text-sm text-ink-muted">
              {draftState.players.length - availablePlayers.length}/{draftState.players.length} players have been drafted.
            </p>
            {availablePlayers.length > 0 && (
              <div role="alert" className="mt-3 border border-rule p-3 text-ink">
                <p className="font-semibold">Undrafted players ({availablePlayers.length})</p>
                <ul className="max-h-40 overflow-y-auto">{availablePlayers.map(player => <li key={player.id}>{player.name}</li>)}</ul>
              </div>
            )}
          </div>

          <div className="px-6 py-4 border-t border-rule flex justify-end gap-2 shrink-0">
            <button
              onClick={controls.onCancelComplete}
              disabled={isLoading}
              className="text-xs font-semibold uppercase tracking-button text-ink-muted hover:text-ink border border-rule hover:border-rule-strong px-4 py-2 rounded-button disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              Back to review
            </button>
            <button
              onClick={controls.onFinalizeDraft}
              disabled={isLoading}
              className="bg-brand hover:bg-brand-strong text-white text-xs font-semibold uppercase tracking-button px-4 py-2 rounded-button disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isLoading ? 'Finalizing…' : 'Finalize draft'}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Shared building blocks — kept in-file to avoid premature extraction.
// ---------------------------------------------------------------------------

interface ConfirmBannerProps {
  label: string;
  labelIcon?: React.ReactNode;
  labelTone: 'default' | 'alert' | 'warn';
  headline: string;
  detail?: string;
  detailMono?: boolean;
  primaryLabel: string;
  onPrimary: () => void;
  cancellable: boolean;
  onCancel: () => void;
  isLoading: boolean;
}

const ConfirmBanner = ({
  label,
  labelIcon,
  labelTone,
  headline,
  detail,
  detailMono,
  primaryLabel,
  onPrimary,
  cancellable,
  onCancel,
  isLoading,
}: ConfirmBannerProps) => {
  const labelClass =
    labelTone === 'alert'
      ? 'text-alert'
      : labelTone === 'warn'
      ? 'text-warn'
      : 'text-ink-muted';

  return (
    <>
      <div className={`font-mono text-[11px] uppercase tracking-label mb-2 flex items-center gap-1.5 ${labelClass}`}>
        {labelIcon}
        {label}
      </div>
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="text-2xl font-semibold text-ink truncate">{headline}</div>
          {detail && (
            <div
              className={`mt-0.5 text-xs ${
                detailMono ? 'font-mono tabular-nums text-ink-muted' : 'text-ink-muted'
              }`}
            >
              {detail}
            </div>
          )}
        </div>
        <button
          onClick={onPrimary}
          disabled={isLoading}
          className="flex-shrink-0 bg-brand hover:bg-brand-strong text-white text-xs font-semibold uppercase tracking-button px-4 py-2 rounded-button disabled:opacity-50 transition-colors"
        >
          {isLoading ? 'Working…' : primaryLabel}
        </button>
        {cancellable && (
          <button
            onClick={onCancel}
            disabled={isLoading}
            className="flex-shrink-0 text-ink-muted hover:text-ink p-1.5 rounded-sharp disabled:opacity-50 transition-colors"
            title="Cancel"
          >
            <X className="w-4 h-4" />
          </button>
        )}
      </div>
    </>
  );
};

interface ModalProps {
  children: React.ReactNode;
  onDismiss?: () => void;
  maxWidth: 'md' | 'lg';
}

const Modal = ({ children, onDismiss, maxWidth }: ModalProps) => {
  useEffect(() => {
    if (!onDismiss) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDismiss]);

  const widthClass = maxWidth === 'lg' ? 'max-w-lg' : 'max-w-md';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4" role="presentation">
      {onDismiss ? (
        <button
          type="button"
          className="absolute inset-0 bg-scrim"
          onClick={onDismiss}
          aria-label="Close dialog"
        />
      ) : (
        <div className="absolute inset-0 bg-scrim" aria-hidden="true" />
      )}
      <div
        className={`relative z-10 bg-surface border border-rule rounded-sharp shadow-lg w-full ${widthClass} max-h-[90vh] flex flex-col overflow-hidden`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        {children}
      </div>
    </div>
  );
};
