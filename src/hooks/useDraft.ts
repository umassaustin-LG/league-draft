import { useState, useCallback, useRef, useMemo } from 'react';
import { Player, Team, DraftState, DraftFormat, AppPhase, Division, PickWarning } from '../types';
import { api, ApiError } from '../api/client';
import { clearForeignCoachMandatoryPick } from '../utils/draftLogic';

/**
 * Check if an error is a session expiry error (401 Unauthorized)
 */
function isSessionExpiredError(err: unknown): boolean {
  return err instanceof ApiError && err.status === 401;
}

/**
 * Get a user-friendly error message from an API error
 */
function getErrorMessage(err: unknown, defaultMessage: string): string {
  if (isSessionExpiredError(err)) {
    return 'Your session has expired. Please log in again to continue.';
  }
  if (err instanceof ApiError) {
    // Check for specific error details from the API
    if (err.details?.error && typeof err.details.error === 'string') {
      return err.details.error;
    }
    if (err.details?.detail && typeof err.details.detail === 'string') {
      return err.details.detail;
    }
  }
  return defaultMessage;
}

const initialDraftState: DraftState = {
  players: [],
  teams: [],
  draftFormat: 'snake',
  draftOrder: [],
  currentRoundOrder: [],
  picks: [],
  currentRound: 1,
  currentPickInRound: 1,
  currentTeamId: null,
  isDraftComplete: false,
  mandatoryPick: undefined,
  trades: [],
};

export const useDraft = (_divisionId?: string) => {
  const [phase, setPhase] = useState<AppPhase>('upload');
  const [savedDraftState, setDraftState] = useState<DraftState>(initialDraftState);
  const draftState = useMemo(() => clearForeignCoachMandatoryPick(savedDraftState), [savedDraftState]);
  const [pendingComplete, setPendingComplete] = useState(false);
  const [isViewingCompletedDraftBoard, setIsViewingCompletedDraftBoard] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pendingRuleWarnings, setPendingRuleWarnings] = useState<{ playerId: string; warnings: PickWarning[] } | null>(null);
  const clearPendingRuleWarnings = useCallback(() => setPendingRuleWarnings(null), []);
  const [mandatoryPickError, setMandatoryPickError] = useState<string | null>(null);

  // Store draft state ID (needed for API draft operations)
  const draftStateId = useRef<string | null>(null);

  // Track the current division ID
  const currentDivisionId = useRef<string | undefined>(_divisionId);

  // Synchronous lock to prevent concurrent operations (prevents race conditions from rapid clicks)
  const operationInProgress = useRef(false);

  // Load state from a division object (called when selecting a division)
  const loadDivisionState = useCallback((division: Division) => {
    setPendingRuleWarnings(null);
    currentDivisionId.current = division.id;

    // If division has a saved draft state, use it
    if (division.draftState) {
      setDraftState(division.draftState);
      // Store draft state ID for API operations
      if (division.draftState.id) {
        draftStateId.current = division.draftState.id;
      }
    } else {
      // Otherwise, initialize from division's players and teams
      setDraftState({
        ...initialDraftState,
        players: division.players,
        teams: division.teams,
      });
      draftStateId.current = null;
    }

    setPhase(division.phase);
    setPendingComplete(division.phase === 'draft' && !!division.draftState?.isDraftComplete);
    setIsViewingCompletedDraftBoard(false);
  }, []);

  const resetDraft = useCallback(async (
    targetPhase?: AppPhase,
    preservedPlayers?: Player[],
    preservedTeams?: Team[]
  ) => {
    setIsViewingCompletedDraftBoard(false);
    setPendingRuleWarnings(null);
    const divisionId = currentDivisionId.current;

    // If targetPhase and preserved data provided, reset to that phase with data intact
    if (targetPhase && preservedPlayers && preservedTeams) {
      if (divisionId) {
        try {
          setIsLoading(true);
          const division = await api.resetDraft(divisionId);
          setDraftState({
            ...initialDraftState,
            players: division.players,
            teams: division.teams,
          });
          draftStateId.current = null;
          setError(null);
        } catch (err) {
          console.error('Failed to reset draft:', err);
          setError(getErrorMessage(err, 'Failed to reset draft on server, but local state has been reset.'));
          // Still reset local state even if API fails
          setDraftState({
            ...initialDraftState,
            players: preservedPlayers,
            teams: preservedTeams,
          });
          draftStateId.current = null;
        } finally {
          setIsLoading(false);
        }
      } else {
        setDraftState({
          ...initialDraftState,
          players: preservedPlayers,
          teams: preservedTeams,
        });
      }
      // Always set phase regardless of API success/failure
      setPhase(targetPhase);
      return;
    }

    // Full reset - clear everything
    if (divisionId) {
      try {
        setIsLoading(true);
        await api.resetDraft(divisionId);
        draftStateId.current = null;
        setError(null);
      } catch (err) {
        console.error('Failed to reset draft:', err);
        setError('Failed to reset draft');
      } finally {
        setIsLoading(false);
      }
    }

    setPhase('upload');
    setDraftState(initialDraftState);
  }, []);

  const setPlayers = useCallback((players: Player[]) => {
    setDraftState((prev) => ({ ...prev, players }));
  }, []);

  const setTeams = useCallback((teams: Team[]) => {
    setDraftState((prev) => ({ ...prev, teams }));
  }, []);

  const setDraftFormat = useCallback((format: DraftFormat) => {
    setDraftState((prev) => ({ ...prev, draftFormat: format }));
  }, []);

  const setDraftOrder = useCallback((order: string[]) => {
    setDraftState((prev) => ({ ...prev, draftOrder: order }));
  }, []);

  const startDraft = useCallback(async (format?: DraftFormat, order?: string[], _resolvedPlayers?: Player[]) => {
    // Guard against concurrent operations (Issue #1, #25)
    if (isLoading) {
      return;
    }

    const divisionId = currentDivisionId.current;
    if (!divisionId) {
      setError('No division selected');
      return;
    }

    try {
      setIsLoading(true);
      const draftFormat = format ?? draftState.draftFormat;
      const draftOrder = order ?? draftState.draftOrder;

      const result = await api.startDraft({
        divisionId,
        draftFormat,
        draftOrder,
      });

      // Store the draft state ID for future operations
      draftStateId.current = result.draftState.id || null;

      setDraftState(result.draftState);
      setError(null);

      // Transition to draft phase
      setTimeout(() => {
        setPhase('draft');
      }, 0);
    } catch (err) {
      console.error('Failed to start draft:', err);
      setError(getErrorMessage(err, 'Failed to start draft. Please try again.'));
    } finally {
      setIsLoading(false);
    }
  }, [draftState.draftFormat, draftState.draftOrder, isLoading]);

  const draftPlayer = useCallback(
    async (playerId: string, options: { acknowledgeWarnings?: boolean } = {}) => {
      // Synchronous lock check AND set to prevent race conditions from rapid clicks
      // Must be done atomically at the very start before any async operations
      if (operationInProgress.current) {
        console.log('[draftPlayer] Blocked - operation already in progress');
        return;
      }
      operationInProgress.current = true;

      // Guard against double-submit during API call (Issue #1)
      if (isLoading) {
        console.log('[draftPlayer] Blocked - isLoading true');
        operationInProgress.current = false;
        return;
      }

      if (!draftStateId.current) {
        setError('Draft not started');
        operationInProgress.current = false;
        return;
      }

      const { currentTeamId, players, mandatoryPick } = draftState;

      if (!currentTeamId) {
        operationInProgress.current = false;
        return;
      }

      // Validate mandatory pick
      if (mandatoryPick && mandatoryPick.playerId !== playerId) {
        const playerName = players.find(p => p.id === mandatoryPick.playerId)?.name;
        const reason = mandatoryPick.reason === 'coach-kid' ? "coach's kid" : 'sibling requirement';
        setMandatoryPickError(`You must draft ${playerName} (${reason})`);
        operationInProgress.current = false;
        return;
      }

      try {
        setIsLoading(true);
        const result = await api.draftPlayer({
          draftStateId: draftStateId.current,
          playerId,
          teamId: currentTeamId,
          acknowledgeWarnings: options.acknowledgeWarnings,
        });

        setDraftState(result.draftState);
        setPendingRuleWarnings(null);
        setError(null);

        // Check if draft is complete
        const availablePlayers = result.players.filter(p => !p.isDrafted);
        if (availablePlayers.length === 0 || result.draftState.isDraftComplete) {
          setTimeout(() => setPendingComplete(true), 300);
        }
      } catch (err) {
        console.error('Failed to draft player:', err);
        if (err instanceof ApiError && err.status === 409 && Array.isArray(err.details?.warnings)) {
          setPendingRuleWarnings({ playerId, warnings: err.details.warnings as PickWarning[] });
          setError(null);
        } else {
          setPendingRuleWarnings(null);
          setError(getErrorMessage(err, 'Failed to draft player. Please try again.'));
        }
      } finally {
        operationInProgress.current = false;
        setIsLoading(false);
      }
    },
    [draftState, isLoading]
  );

  const confirmOverride = useCallback(async () => {
    if (pendingRuleWarnings) {
      await draftPlayer(pendingRuleWarnings.playerId, { acknowledgeWarnings: true });
    }
  }, [pendingRuleWarnings, draftPlayer]);

  const undoLastPick = useCallback(async (expectedPick?: number) => {
    // Synchronous lock check to prevent race conditions from rapid clicks
    if (operationInProgress.current) {
      return;
    }

    // Guard against concurrent operations (Issue #1)
    if (isLoading) {
      return;
    }

    if (!draftStateId.current) {
      setError('Draft not started');
      return;
    }

    try {
      operationInProgress.current = true;
      setIsLoading(true);
      const result = await api.undoLastPick(draftStateId.current, expectedPick ?? draftState.picks[draftState.picks.length - 1]?.pick);
      setDraftState(result.draftState);
      setError(null);

      // If we're on complete screen, go back to draft
      if (phase === 'complete') {
        setIsViewingCompletedDraftBoard(false);
        setPhase('draft');
      }
    } catch (err) {
      console.error('Failed to undo pick:', err);
      setError(getErrorMessage(err, 'Failed to undo pick. Please try again.'));
    } finally {
      operationInProgress.current = false;
      setIsLoading(false);
    }
  }, [phase, isLoading, draftState.picks]);

  // Skip the current pick (team gets one fewer player)
  const skipPick = useCallback(async () => {
    // Synchronous lock check to prevent race conditions from rapid clicks
    if (operationInProgress.current) {
      return;
    }

    // Guard against concurrent operations (Issue #1)
    if (isLoading) {
      return;
    }

    if (!draftStateId.current) {
      setError('Draft not started');
      return;
    }

    if (!draftState?.currentTeamId) {
      setError('No current team to skip');
      return;
    }

    try {
      operationInProgress.current = true;
      setIsLoading(true);
      const result = await api.skipPick({
        draftStateId: draftStateId.current,
        teamId: draftState.currentTeamId,
      });
      setDraftState(result.draftState);
      setError(null);
      if (result.draftState.isDraftComplete) setPendingComplete(true);
    } catch (err) {
      console.error('Failed to skip pick:', err);
      setError(getErrorMessage(err, 'Failed to skip pick. Please try again.'));
    } finally {
      operationInProgress.current = false;
      setIsLoading(false);
    }
  }, [draftState?.currentTeamId, isLoading]);

  // Execute a trade between two teams
  const executeTrade = useCallback(async (
    team1Id: string,
    team2Id: string,
    player1Id: string,
    player2Id: string,
    reason: string
  ) => {
    // Synchronous lock check to prevent race conditions from rapid clicks
    if (operationInProgress.current) {
      return;
    }

    // Guard against concurrent operations (Issue #1)
    if (isLoading) {
      return;
    }

    if (!draftStateId.current) {
      setError('Draft not started');
      return;
    }

    try {
      operationInProgress.current = true;
      setIsLoading(true);
      const result = await api.createTrade({
        draftStateId: draftStateId.current,
        team1Id,
        team2Id,
        player1Id,
        player2Id,
        reason,
      });
      setDraftState(result.draftState);
      setError(null);
    } catch (err) {
      console.error('Failed to execute trade:', err);
      setError(getErrorMessage(err, 'Failed to execute trade. Please try again.'));
      // Re-throw so TradeModal can handle it (e.g., re-enable submit button)
      throw err;
    } finally {
      operationInProgress.current = false;
      setIsLoading(false);
    }
  }, [isLoading]);

  // Finalize draft and navigate to complete phase
  const finalizeDraft = useCallback(() => {
    setPendingComplete(false);
    setIsViewingCompletedDraftBoard(false);
    setPhase('complete');
  }, []);

  // Cancel pending complete (go back to review draft)
  const cancelPendingComplete = useCallback(() => {
    setPendingComplete(false);
  }, []);

  const requestFinalization = useCallback(() => {
    if (phase === 'draft' && (draftState.isDraftComplete
      || draftState.players.length > 0 && draftState.players.every(player => player.isDrafted))) {
      setPendingComplete(true);
    }
  }, [phase, draftState]);

  // Clear mandatory pick error
  const clearMandatoryPickError = useCallback(() => {
    setMandatoryPickError(null);
  }, []);

  // Reviewing the board does not change the finalized draft phase.
  const returnToDraftBoard = useCallback(() => {
    setPendingComplete(false);
    setIsViewingCompletedDraftBoard(true);
  }, []);

  const viewResults = useCallback(() => {
    setIsViewingCompletedDraftBoard(false);
  }, []);

  return {
    phase,
    setPhase,
    draftState,
    pendingComplete,
    setPlayers,
    setTeams,
    setDraftFormat,
    setDraftOrder,
    startDraft,
    draftPlayer,
    skipPick,
    undoLastPick,
    resetDraft,
    loadDivisionState,
    executeTrade,
    finalizeDraft,
    cancelPendingComplete,
    requestFinalization,
    isLoading,
    error,
    mandatoryPickError,
    pendingRuleWarnings,
    clearPendingRuleWarnings,
    confirmOverride,
    clearMandatoryPickError,
    returnToDraftBoard,
    isViewingCompletedDraftBoard,
    viewResults,
  };
};
