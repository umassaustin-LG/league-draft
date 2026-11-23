import { useState, useEffect, useCallback, useRef } from 'react';
import { useDivisions } from './hooks/useDivisions';
import { useDraft } from './hooks/useDraft';
import { usePlayerScoring } from './hooks/usePlayerScoring';
import { useViewMode } from './contexts/ViewContext';
import { useAuth } from './contexts/AuthContext';
import { DivisionSelector } from './components/DivisionSelector';
import { DivisionCreator } from './components/DivisionCreator';
import { FileUpload } from './components/FileUpload';
import { ColumnMapper } from './components/ColumnMapper';
import { ImportTypeSelector, EvaluationImport } from './components/evaluation';
import { CSVImportFlow, DualCSVImportResult } from './components/evaluation/CSVImportFlow';
import { RegistrationCSVRecord } from './components/evaluation/DualCSVUpload';
import { PlayerReview } from './components/PlayerReview';
import { DraftConfig } from './components/DraftConfig';
import { DraftBoard } from './components/DraftBoard';
import { DraftComplete } from './components/DraftComplete';
import { TeamBuilderFlow } from './components/TeamBuilderFlow';
import { LoginPage } from './components/LoginPage';
import { RegisterPage } from './components/RegisterPage';
import { ForgotPasswordPage } from './components/ForgotPasswordPage';
import { ResetPasswordPage } from './components/ResetPasswordPage';
import { ProfilePage } from './components/profile';
import { JoinPage } from './components/JoinPage';
import { EvaluationAdmin } from './components/evaluation/EvaluationAdmin';
import { DivisionOverview } from './components/DivisionOverview';
import { api, isApiMode } from './api';
import {
  Player,
  Team,
  DraftFormat,
  ParsedCSVData,
  ColumnMapping,
  DivisionPreset,
  DivisionAgeRange,
  DivisionMode,
  ScoringMode,
  AppPhase,
} from './types';
import { parseCSVWithMapping, CoachAssignment } from './utils/csvParser';
import { canManageDivision, canUsePersonalWorkspace, getDefaultLeagueAdminMembership } from './utils/divisionAccess';
import { savePlayersToApi, saveTeamsToApi } from './api';

type AppMode = 'selector' | 'creator' | 'draft' | 'settings' | 'join' | 'templates';
type AuthPage = 'login' | 'register' | 'forgot-password' | 'reset-password';

function App() {
  // All hooks must be called unconditionally at the top
  const viewMode = useViewMode();
  const isPublicView = viewMode === 'public';
  const { isAuthenticated, isInitialized, user, logout, checkAuth } = useAuth();
  const [authPage, setAuthPage] = useState<AuthPage>('login');
  const [resetParams, setResetParams] = useState<{ uid: string; token: string } | null>(null);
  const [joinToken, setJoinToken] = useState<string | null>(null);

  // Check for password reset and join URL params on mount
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const pathname = window.location.pathname;

    // Check for password reset
    const uid = params.get('uid');
    const token = params.get('token');
    if (uid && token && pathname === '/reset-password') {
      setResetParams({ uid, token });
      setAuthPage('reset-password');
      return;
    }

    // Sanitize token - remove any non-URL-safe characters (hidden unicode, etc.)
    const sanitizeToken = (token: string): string => {
      // Only allow alphanumeric, dash, underscore, and common base64 chars
      return token.replace(/[^a-zA-Z0-9_-]/g, '');
    };

    // Check for join link with token in path: /join/{token}
    if (pathname.startsWith('/join/')) {
      const pathToken = pathname.replace('/join/', '');
      if (pathToken) {
        setJoinToken(sanitizeToken(decodeURIComponent(pathToken)));
        setMode('join');
        return;
      }
    }

    // Check for join invitation with token in query: /join?token={token}
    const inviteToken = params.get('token');
    if (pathname === '/join' && inviteToken) {
      setJoinToken(sanitizeToken(inviteToken));
      setMode('join');
    }
  }, []);
  const [mode, setMode] = useState<AppMode>('selector');
  const [csvData, setCSVData] = useState<ParsedCSVData | null>(null);
  const [importMode, setImportMode] = useState<'csv' | 'excel' | 'dualcsv' | null>(null);
  // Dual CSV verification result - stores excluded rows and DNE players
  const [dualCSVVerification, setDualCSVVerification] = useState<{
    excludedRowIndices: Set<number>;
    dnePlayers: RegistrationCSVRecord[];
  } | null>(null);

  const {
    summaries,
    activeDivision,
    createDivision,
    selectDivision,
    updateActiveDivision,
    deleteDivision,
    clearActiveDivision,
    refreshSummaries,
  } = useDivisions(user?.id);
  const canEditDivision = !isPublicView && !!activeDivision && canManageDivision(user, activeDivision);
  const leagueAdminMembership = getDefaultLeagueAdminMembership(user);
  const canCreateDivision = !isPublicView && (!!leagueAdminMembership || canUsePersonalWorkspace(user));

  const {
    phase,
    setPhase,
    draftState,
    pendingComplete,
    setPlayers,
    setTeams,
    startDraft,
    draftPlayer,
    skipPick,
    undoLastPick,
    resetDraft,
    loadDivisionState,
    executeTrade,
    finalizeDraft,
    cancelPendingComplete,
    isLoading,
    mandatoryPickError,
    error: draftError,
    pendingRuleWarnings,
    clearPendingRuleWarnings,
    confirmOverride,
    clearMandatoryPickError,
    returnToDraftBoard,
  } = useDraft(activeDivision?.id);

  const { players, updatePlayer, updatePlayerField, linkSiblings, unlinkSibling, setAllPlayers } = usePlayerScoring(
    draftState.players,
    activeDivision?.teamCount ?? 8
  );

  // Local teams state for the review phase (before draft starts)
  const [teams, setTeamsState] = useState<Team[]>([]);

  // Sync teams from active division when it changes
  useEffect(() => {
    if (activeDivision && activeDivision.teams.length > 0) {
      setTeamsState(activeDivision.teams);
    }
  }, [activeDivision?.id]); // Only trigger when division changes

  // Load division state when activeDivision changes
  useEffect(() => {
    if (activeDivision) {
      setMode('draft');
      if (canEditDivision) loadDivisionState(activeDivision);
    }
  }, [activeDivision, canEditDivision, loadDivisionState]);

  // Scroll to top when phase changes
  useEffect(() => {
    window.scrollTo(0, 0);
  }, [phase]);

  // Track if division state has been loaded (to avoid overwriting API phase with default 'upload')
  const [divisionStateLoaded, setDivisionStateLoaded] = useState(false);

  // Track if we're currently updating to prevent race conditions (Issue #6)
  const isUpdatingPhase = useRef(false);

  // Track save errors to display to user (Issue #27 - silent failures)
  const [saveError, setSaveError] = useState<string | null>(null);

  // Track loading state for phase transitions (Issue #27 - missing loading feedback)
  const [isSaving, setIsSaving] = useState(false);

  // Reset divisionStateLoaded when division changes
  useEffect(() => {
    setDivisionStateLoaded(false);
    isUpdatingPhase.current = false;
  }, [activeDivision?.id]);

  // Mark division state as loaded after loadDivisionState runs
  useEffect(() => {
    if (activeDivision && !divisionStateLoaded) {
      // Small delay to ensure loadDivisionState has completed
      const timer = setTimeout(() => setDivisionStateLoaded(true), 100);
      return () => clearTimeout(timer);
    }
  }, [activeDivision, divisionStateLoaded]);

  // Save phase changes back to division (only after initial load)
  useEffect(() => {
    // Only sync phase changes AFTER the division state has been loaded
    // This prevents the default 'upload' phase from overwriting the API-loaded phase
    // Also prevent concurrent updates (Issue #6)
    if (canEditDivision && divisionStateLoaded && activeDivision && phase !== activeDivision.phase && !isUpdatingPhase.current) {
      isUpdatingPhase.current = true;
      // When draft completes, save the completion timestamp and final state
      // Note: Don't pass players here - they're already saved by draft pick API
      // Trying to re-save would trigger delete/recreate which is blocked during draft/complete
      if (phase === 'complete') {
        updateActiveDivision({
          phase,
          completedAt: new Date().toISOString(),
          draftState,
          teams: draftState.teams,
        }).then(() => {
          setSaveError(null);
        }).catch((err) => {
          console.error('Failed to save draft completion:', err);
          // Show user-friendly error message
          const message = err instanceof Error ? err.message : 'Unknown error';
          setSaveError(`Failed to save draft completion: ${message}. Your draft data may not be saved. Please try refreshing the page.`);
        }).finally(() => {
          isUpdatingPhase.current = false;
        });
      } else {
        updateActiveDivision({ phase }).then(() => {
          setSaveError(null);
        }).catch((err) => {
          console.error('Failed to save phase change:', err);
          const message = err instanceof Error ? err.message : 'Unknown error';
          setSaveError(`Failed to save progress: ${message}. Please check your connection and try again.`);
        }).finally(() => {
          isUpdatingPhase.current = false;
        });
      }
    }
  }, [phase, activeDivision?.id, canEditDivision, divisionStateLoaded]);

  // Browser history management - handle back/forward navigation
  // Strategy: Push a state entry on load, and when user presses back,
  // re-push to prevent actual navigation while keeping the app stable
  useEffect(() => {
    // Push initial state on mount to have something in history
    window.history.replaceState({ appState: true }, '');
    window.history.pushState({ appState: true }, '');

    const handlePopState = () => {
      // User pressed back button - push state again to prevent leaving the app
      // This keeps the user in the app without losing any data
      window.history.pushState({ appState: true }, '');
    };

    window.addEventListener('popstate', handlePopState);
    return () => window.removeEventListener('popstate', handlePopState);
  }, []);

  // Handle selecting an existing division
  const handleSelectDivision = useCallback((divisionId: string) => {
    selectDivision(divisionId);
  }, [selectDivision]);

  // Handle creating a new division
  const handleCreateDivision = useCallback(async (config: {
    name: string;
    preset: DivisionPreset;
    mode: DivisionMode;
    teamCount: number;
    ageRange: DivisionAgeRange;
    enforceAgeLimit: boolean;
    maxPerAge: number;
    coaches: Array<{ headCoach: string; assistantCoach: string }>;
  }) => {
    const division = await createDivision(config);
    if (division) {
      setMode('draft');
    }
  }, [createDivision]);

  // Handle CSV parsing
  const handleCSVParsed = (parsedData: ParsedCSVData) => {
    setCSVData(parsedData);
  };

  // Handle column mapping completion
  const handleMappingComplete = async (mapping: ColumnMapping) => {
    if (!csvData || !activeDivision) return;

    // If coming from dual CSV flow, filter out excluded rows before parsing
    let dataToProcess = csvData;
    if (dualCSVVerification && dualCSVVerification.excludedRowIndices.size > 0) {
      dataToProcess = {
        headers: csvData.headers,
        rows: csvData.rows.filter((_, index) => !dualCSVVerification.excludedRowIndices.has(index)),
      };
    }

    const { players: loadedPlayers, coachAssignments } = parseCSVWithMapping(
      dataToProcess,
      mapping,
      activeDivision.teamCount,
      activeDivision.scoringMode,
      activeDivision.scoringWeights
    );

    // Process coach assignments from CSV
    let updatedTeams = [...activeDivision.teams];
    let updatedPlayers = [...loadedPlayers];

    // If coming from dual CSV flow, add DNE players at the end
    if (dualCSVVerification && dualCSVVerification.dnePlayers.length > 0) {
      const maxBib = Math.max(...updatedPlayers.map(p => parseInt(p.bib) || 0), 0);

      dualCSVVerification.dnePlayers.forEach((dnePlayer, index) => {
        const nextBib = maxBib + index + 1;
        const dnePlayerRecord: Player = {
          id: `player-dne-${nextBib}-${Date.now()}`,
          bib: String(nextBib),
          firstName: dnePlayer.firstName,
          lastName: dnePlayer.lastName,
          name: `${dnePlayer.firstName} ${dnePlayer.lastName}`,
          // All scores 0 for DNE
          fieldScore: 0,
          throwScore: 0,
          hitPower: 0,
          hitForm: 0,
          hitContact: 0,
          pitchingStrength: 0,
          pitchingForm: 0,
          catchScore: 0,
          runningScore: 0,
          fieldingSubtotal: 0,
          hittingSubtotal: 0,
          pitchingSubtotal: 0,
          subjectiveTotal: 0,
          objectiveTotal: 0,
          officialAdjust: 0,
          totalScore: 0,
          rank: updatedPlayers.length + index + 1,
          projectedRound: Math.ceil((updatedPlayers.length + index + 1) / activeDivision.teamCount),
          littleLeagueAge: 0,
          birthday: '',
          isAllStar: false,
          isDNE: true,
          isCoachKid: false,
          isDrafted: false,
        };
        updatedPlayers.push(dnePlayerRecord);
      });

      // Re-sort by score and re-rank (DNE players will be at the bottom with 0 score)
      updatedPlayers.sort((a, b) => b.totalScore - a.totalScore);
      updatedPlayers.forEach((p, i) => {
        p.rank = i + 1;
        p.projectedRound = Math.ceil((i + 1) / activeDivision.teamCount);
      });
    }

    // Clear dual CSV verification state after processing
    setDualCSVVerification(null);

    if (coachAssignments.length > 0) {
      // Group assignments by team name
      const teamAssignments = new Map<string, CoachAssignment[]>();
      coachAssignments.forEach(assignment => {
        const existing = teamAssignments.get(assignment.teamName) || [];
        existing.push(assignment);
        teamAssignments.set(assignment.teamName, existing);
      });

      // Track team coach info for auto-detection (from teamColumn format)
      const teamCoachInfo = new Map<string, { managerName: string; assistantName?: string }>();

      // Process each team's assignments - create teams and track coach names
      teamAssignments.forEach((assignments, coachName) => {
        // Find team by headCoach name (manager's last name)
        let team = updatedTeams.find(t =>
          t.headCoach.toLowerCase() === coachName.toLowerCase()
        );

        // If team not found by headCoach, find first team without a coach and assign
        if (!team) {
          team = updatedTeams.find(t => !t.headCoach || t.headCoach.trim() === '');
          if (team) {
            team.headCoach = coachName;
          }
        }

        if (team) {
          // Check if any assignment has assistantName (teamColumn format)
          const teamColumnAssignment = assignments.find(a => a.assistantName !== undefined);
          if (teamColumnAssignment) {
            // Track coach names for auto-detection
            teamCoachInfo.set(team.id, {
              managerName: coachName,
              assistantName: teamColumnAssignment.assistantName,
            });
            // Set head coach and assistant coach names
            team.headCoach = coachName;
            if (teamColumnAssignment.assistantName) {
              team.assistantCoach = teamColumnAssignment.assistantName;
            }
          } else {
            // Legacy format - process individual player assignments
            assignments.forEach(assignment => {
              const playerIndex = updatedPlayers.findIndex(p => p.id === assignment.playerId);
              if (playerIndex !== -1) {
                const player = updatedPlayers[playerIndex];

                if (assignment.role === 'manager') {
                  updatedPlayers[playerIndex] = {
                    ...player,
                    isCoachKid: true,
                    coachTeamId: team!.id,
                  };
                  if (!team!.coachKids.includes(player.id)) {
                    team!.coachKids.push(player.id);
                  }
                  // Set head coach from manager's last name
                  team!.headCoach = player.lastName;
                } else {
                  updatedPlayers[playerIndex] = {
                    ...player,
                    isCoachKid: true,
                    coachTeamId: team!.id,
                  };
                  if (!team!.coachKids.includes(player.id)) {
                    team!.coachKids.push(player.id);
                  }
                  // Set assistant coach (single value, last one wins)
                  team!.assistantCoach = player.lastName;
                }
              }
            });
          }
        }
      });

      // NOTE: We do NOT auto-mark coach's kids here during import.
      // The user should use "Find Coaches' Kids and Siblings" button to review
      // and confirm matches before they are applied.
    }

    // In API mode, save players and teams to the database
    if (isApiMode()) {
      try {
        setIsSaving(true);
        // Save teams first (for coach assignments)
        await saveTeamsToApi(activeDivision.id, updatedTeams);
        // Save players
        const savedPlayers = await savePlayersToApi(activeDivision.id, updatedPlayers);
        updatedPlayers = savedPlayers;
        await updateActiveDivision({
          rosterSize: Math.ceil(updatedPlayers.length / activeDivision.teamCount),
          phase: 'review',
        });
      } catch (err) {
        // Issue #5: Show error and return early on save failures
        console.error('Failed to save to API:', err);
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        alert(`Failed to save player data: ${errorMessage}\n\nPlease try again or check your network connection.`);
        return; // Don't continue with corrupted state
      } finally {
        setIsSaving(false);
      }
    } else {
      await updateActiveDivision({
        players: updatedPlayers,
        teams: updatedTeams,
        rosterSize: Math.ceil(updatedPlayers.length / activeDivision.teamCount),
        phase: 'review',
      });
    }

    setAllPlayers(updatedPlayers);
    setPlayers(updatedPlayers);

    setTeamsState(updatedTeams);

    setPhase('review');
  };

  // Handle Excel evaluation import completion
  // Skips review phase since all adjustments are done in the evaluation summary
  const handleEvaluationComplete = async (
    importedPlayers: Player[],
    teamNames: string[],
    assistantCoaches: string[]
  ) => {
    if (!activeDivision) return;

    // Update teams with coach info from evaluation
    // teamNames array contains head coach last names (used for display until actual team name assigned)
    let updatedTeams = activeDivision.teams.map((team, i) => ({
      ...team,
      // Don't set teamName here - it should remain empty until actual team name (e.g., "Guardians") is assigned
      // Display will fall back to headCoach via getTeamDisplayName()
      headCoach: teamNames[i] || team.headCoach,
      assistantCoach: assistantCoaches[i] || team.assistantCoach,
    }));

    // Build mapping from temporary team IDs (team-0, team-1) to actual division team IDs
    // The evaluation import generates team IDs as "team-{index}" but division teams have IDs like "majors-team-1"
    const teamIdMapping: Record<string, string> = {};
    activeDivision.teams.forEach((team, i) => {
      teamIdMapping[`team-${i}`] = team.id;
    });

    // Fix coachTeamId references to use actual division team IDs
    let fixedPlayers = importedPlayers.map(player => {
      if (player.coachTeamId && teamIdMapping[player.coachTeamId]) {
        return { ...player, coachTeamId: teamIdMapping[player.coachTeamId] };
      }
      return player;
    });

    // In API mode, save players and teams to the database
    if (isApiMode()) {
      try {
        // Save teams first (for coach assignments)
        await saveTeamsToApi(activeDivision.id, updatedTeams);
        // Save players
        const savedPlayers = await savePlayersToApi(activeDivision.id, fixedPlayers);
        fixedPlayers = savedPlayers;
      } catch (err) {
        // Issue #5: Show error and return early on save failures
        console.error('Failed to save to API:', err);
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        alert(`Failed to save player data: ${errorMessage}\n\nPlease try again or check your network connection.`);
        return; // Don't continue with corrupted state
      }
    }

    setAllPlayers(fixedPlayers);
    setPlayers(fixedPlayers);
    setTeamsState(updatedTeams);
    setTeams(updatedTeams);  // Sync teams to draft state so names display on draft board

    // Update division with fixed players and updated teams
    updateActiveDivision({
      players: fixedPlayers,
      teams: updatedTeams,
      rosterSize: Math.ceil(fixedPlayers.length / activeDivision.teamCount),
    });

    setImportMode(null);
    setPhase('config');  // Skip review, go straight to draft config
  };

  // Handle scoring mode change
  const handleScoringModeChange = (mode: ScoringMode) => {
    if (!activeDivision) return;
    updateActiveDivision({ scoringMode: mode });
  };

  // Handle player score updates
  const handlePlayerUpdate = (
    playerId: string,
    field: keyof Pick<Player, 'fieldingSubtotal' | 'hittingSubtotal' | 'pitchingSubtotal' | 'catchScore' | 'runningScore' | 'officialAdjust'>,
    value: number
  ) => {
    updatePlayer(playerId, field, value);
  };

  // Handle review phase completion
  const handleReviewComplete = async (updatedPlayers?: Player[]) => {
    // Use passed players if available, otherwise use current state
    const playersToSave = updatedPlayers ?? players;

    // Update draft state with modified players and teams
    setPlayers(playersToSave);
    setTeams(teams);

    // Save to division
    if (activeDivision) {
      // In API mode, save players to the database (includes coach kid assignments, sibling links, etc.)
      if (isApiMode()) {
        try {
          setIsSaving(true);
          await saveTeamsToApi(activeDivision.id, teams);
          const savedPlayers = await savePlayersToApi(activeDivision.id, playersToSave);
          setPlayers(savedPlayers);
        } catch (err) {
          // Issue #5: Show error and return early on save failures
          console.error('Failed to save players to API:', err);
          const errorMessage = err instanceof Error ? err.message : 'Unknown error';
          alert(`Failed to save player data: ${errorMessage}\n\nPlease try again or check your network connection.`);
          return; // Don't continue with corrupted state
        } finally {
          setIsSaving(false);
        }
      }

      updateActiveDivision({
        players: playersToSave,
        teams,
      });
    }

    setPhase('config');
  };

  // Handle draft config completion
  const handleConfigComplete = async (format: DraftFormat, order: string[], resolvedPlayers: Player[]) => {
    // Update players with resolved lockedToRound values before starting draft
    setPlayers(resolvedPlayers);

    // In API mode, save resolved players (with lockedToRound values) before starting draft
    if (activeDivision && isApiMode()) {
      try {
        setIsSaving(true);
        await savePlayersToApi(activeDivision.id, resolvedPlayers);
      } catch (err) {
        // Issue #5: Show error and return early on save failures
        console.error('Failed to save resolved players to API:', err);
        const errorMessage = err instanceof Error ? err.message : 'Unknown error';
        alert(`Failed to save player data: ${errorMessage}\n\nPlease try again or check your network connection.`);
        return; // Don't continue with corrupted state
      } finally {
        setIsSaving(false);
      }
    }

    // Pass format and order directly to startDraft to avoid race conditions
    startDraft(format, order, resolvedPlayers);
  };

  // Handle going back to division selector
  const handleBackToSelector = async () => {
    // Save current state to division before leaving (fire and forget for API mode)
    if (activeDivision && !isApiMode()) {
      updateActiveDivision({
        players: draftState.players.length > 0 ? draftState.players : activeDivision.players,
        teams: draftState.teams.length > 0 ? draftState.teams : activeDivision.teams,
        draftState: draftState.picks.length > 0 ? draftState : activeDivision.draftState,
        phase,
      });
    }
    clearActiveDivision();
    setMode('selector');
    setCSVData(null);
    setImportMode(null);
  };

  // Handle going back one step at a time
  const handleGoBack = (fromPhase: AppPhase) => {
    if (!activeDivision) return;

    switch (fromPhase) {
      case 'complete':
      case 'draft':
        // Going back from draft/complete resets draft progress but preserves all data
        if (draftState.picks.length > 0) {
          if (!window.confirm('Warning: This will delete all draft rounds and picks. Are you sure you want to return to Draft Setup?')) {
            return;
          }
        }
        // Reset players' draft status but keep all other data
        // Also clear lockedToTeamId which gets set when a sibling is drafted
        const resetPlayers = activeDivision.players.map(p => ({
          ...p,
          isDrafted: false,
          draftedByTeamId: undefined,
          draftedInRound: undefined,
          draftedAtPick: undefined,
          lockedToTeamId: undefined,
        }));
        // Reset team rosters but keep names, coaches, etc.
        const resetTeams = activeDivision.teams.map(t => ({
          ...t,
          roster: [],
          totalScore: 0,
          ageBreakdown: {},
        }));
        updateActiveDivision({
          players: resetPlayers,
          teams: resetTeams,
          draftState: null,
          phase: 'config',
          completedAt: undefined,
        });
        resetDraft('config', resetPlayers, resetTeams);
        break;
      case 'config':
        setPhase('review');
        break;
      case 'review':
        setPhase('upload');
        setImportMode(null);
        break;
      case 'upload':
        handleBackToSelector();
        break;
      default:
        break;
    }
  };

  // Handle reset - this now goes back to config, preserving all data
  const handleReset = () => {
    handleGoBack(phase);
  };

  // Handle individual team update (e.g., assigning team names after draft)
  const handleUpdateTeam = useCallback(async (teamId: string, updates: Partial<Team>) => {
    // Update in draft state
    const updatedTeams = draftState.teams.map(t =>
      t.id === teamId ? { ...t, ...updates } : t
    );
    setTeams(updatedTeams);

    // Persist to API
    if (activeDivision && isApiMode()) {
      try {
        const team = updatedTeams.find(t => t.id === teamId);
        if (team) {
          await api.updateTeam(teamId, {
            teamName: team.teamName,
            headCoach: team.headCoach,
            assistantCoach: team.assistantCoach,
          });
        }
      } catch (err) {
        console.error('Failed to save team update:', err);
      }
    }
  }, [draftState.teams, setTeams, activeDivision]);

  // Handle user update from profile page
  const handleUserUpdate = useCallback(async () => {
    await checkAuth();
  }, [checkAuth]);

  // Handle join completion
  const handleJoinComplete = useCallback(async () => {
    // Refresh auth to get updated leagues
    await checkAuth();
    await refreshSummaries();
    // Clear join state and go to selector
    setJoinToken(null);
    setMode('selector');
    // Clear URL
    window.history.replaceState({}, '', '/');
  }, [checkAuth, refreshSummaries]);

  // Show loading state while checking authentication
  if (isApiMode() && !isInitialized) {
    return (
      <div className="min-h-screen bg-gray-900 flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-8 h-8 border-4 border-blue-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-gray-400">Loading...</p>
        </div>
      </div>
    );
  }

  // Render join page (allow for both authenticated and unauthenticated users)
  // This must come before the auth check so unauthenticated users see the invite details
  if (mode === 'join' && joinToken) {
    return (
      <JoinPage
        token={joinToken}
        onJoinComplete={handleJoinComplete}
        onCancel={() => {
          setJoinToken(null);
          setMode('selector');
          window.history.replaceState({}, '', '/');
        }}
      />
    );
  }

  // Show auth pages when in API mode and not authenticated
  if (isApiMode() && isInitialized && !isAuthenticated) {
    // Helper to go back to login and clear URL
    const handleBackToLogin = () => {
      setAuthPage('login');
      setResetParams(null);
      // Clear URL params
      window.history.replaceState({}, '', '/');
    };

    if (authPage === 'reset-password' && resetParams) {
      return (
        <ResetPasswordPage
          uid={resetParams.uid}
          token={resetParams.token}
          onBackToLogin={handleBackToLogin}
        />
      );
    }
    if (authPage === 'forgot-password') {
      return <ForgotPasswordPage onBackToLogin={handleBackToLogin} />;
    }
    if (authPage === 'register') {
      return <RegisterPage onSwitchToLogin={() => setAuthPage('login')} />;
    }
    return (
      <LoginPage
        onSwitchToRegister={() => setAuthPage('register')}
        onForgotPassword={() => setAuthPage('forgot-password')}
      />
    );
  }

  // Render settings/profile page
  if (mode === 'settings' && user) {
    return (
      <ProfilePage
        user={user}
        onBack={() => setMode('selector')}
        onUserUpdate={handleUserUpdate}
      />
    );
  }

  // Render evaluation admin page
  if (mode === 'templates' && !isPublicView && leagueAdminMembership) {
    return (
      <EvaluationAdmin onBack={() => setMode('selector')} />
    );
  }

  // Render division selector or creator
  if (mode === 'selector' || mode === 'templates') {
    return (
      <DivisionSelector
        divisions={summaries}
        onSelectDivision={handleSelectDivision}
        onCreateNew={canCreateDivision ? () => setMode('creator') : undefined}
        onDeleteDivision={isPublicView ? undefined : deleteDivision}
        creationLeagueName={leagueAdminMembership?.organizationName}
        user={user}
        onLogout={isApiMode() ? logout : undefined}
        onOpenSettings={user && !isPublicView ? () => setMode('settings') : undefined}
        onOpenTemplates={leagueAdminMembership && !isPublicView ? () => setMode('templates') : undefined}
      />
    );
  }

  if (mode === 'creator' && canCreateDivision) {
    // Only check names of divisions that have players (non-empty divisions)
    // Empty divisions are not shown to users, so shouldn't block new creation
    const existingNames = summaries
      .filter(s => s.playerCount > 0)
      .map(s => s.name);

    return (
      <DivisionCreator
        onCancel={() => setMode('selector')}
        onCreate={handleCreateDivision}
        existingNames={existingNames}
      />
    );
  }

  // Render draft flow for active division
  if (!activeDivision) {
    // Loading state or error - shouldn't happen
    return (
      <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
        <div className="text-center">
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
            Loading...
          </h2>
          <button
            onClick={() => setMode('selector')}
            className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg"
          >
            Back to Divisions
          </button>
        </div>
      </div>
    );
  }

  if (!canEditDivision) {
    return (
      <DivisionOverview
        key={activeDivision.id}
        initialDivision={activeDivision}
        onBack={() => {
          void handleBackToSelector();
          void refreshSummaries();
        }}
      />
    );
  }

  // Route to Team Builder for league-generated mode
  if (activeDivision.mode === 'league-generated') {
    return (
      <TeamBuilderFlow
        division={activeDivision}
        onBack={() => {
          void handleBackToSelector();
          void refreshSummaries();
        }}
        onUpdateTeams={(teams) => updateActiveDivision({ teams })}
        onUpdatePlayers={(players) => updateActiveDivision({ players })}
        onUpdatePhase={(phase) => updateActiveDivision({ phase })}
      />
    );
  }

  // Division header shown during draft flow
  const DivisionHeader = () => (
    <div className="fixed top-0 left-0 right-0 z-50 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-2 flex items-center justify-between">
      <div className="flex items-center gap-3">
        {phase !== 'draft' && (
          <>
            <button
              onClick={handleBackToSelector}
              className="text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors text-sm"
            >
              ← Divisions
            </button>
            <span className="text-gray-300 dark:text-gray-600">|</span>
          </>
        )}
        <span className="font-semibold text-gray-900 dark:text-white">
          {activeDivision.name}
        </span>
        <span className="text-sm text-gray-500 dark:text-gray-400">
          ({activeDivision.teamCount} teams)
        </span>
      </div>
    </div>
  );

  return (
    <>
      {phase !== 'upload' && phase !== 'complete' && <DivisionHeader />}

      {/* Saving Overlay (Issue #27 - loading state feedback) */}
      {isSaving && (
        <div className="fixed inset-0 z-50 bg-black/30 flex items-center justify-center">
          <div className="bg-white dark:bg-gray-800 rounded-lg shadow-xl px-6 py-4 flex items-center gap-3">
            <svg className="w-5 h-5 animate-spin text-blue-600" fill="none" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z" />
            </svg>
            <span className="text-gray-700 dark:text-gray-200 font-medium">Saving...</span>
          </div>
        </div>
      )}

      {/* Save Error Banner (Issue #27 - show failures to user) */}
      {saveError && (
        <div className="fixed top-0 left-0 right-0 z-50 bg-red-600 text-white px-4 py-3 shadow-lg">
          <div className="max-w-6xl mx-auto flex items-center justify-between">
            <div className="flex items-center gap-3">
              <svg className="w-5 h-5 flex-shrink-0" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z" clipRule="evenodd" />
              </svg>
              <span className="text-sm font-medium">{saveError}</span>
            </div>
            <button
              onClick={() => setSaveError(null)}
              className="text-white/80 hover:text-white transition-colors"
            >
              <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                <path fillRule="evenodd" d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z" clipRule="evenodd" />
              </svg>
            </button>
          </div>
        </div>
      )}

      <div className={`${phase !== 'upload' && phase !== 'complete' ? 'pt-12' : ''} ${saveError ? 'mt-12' : ''}`}>
        {phase === 'upload' && (
          <div>
            {/* Back button - separate bar above content (hidden for Excel import which has its own) */}
            {importMode !== 'excel' && (
              <div className="bg-gray-100 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-2">
                <button
                  onClick={importMode ? () => setImportMode(null) : handleBackToSelector}
                  className="text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors text-sm flex items-center gap-1"
                >
                  ← {importMode ? 'Back to Import Selection' : 'Back to Divisions'}
                </button>
              </div>
            )}

            {/* Data Ready State - when returning with existing players */}
            {!importMode && (activeDivision?.players.length ?? 0) > 0 && (
              <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
                <div className="max-w-2xl w-full">
                  <div className="text-center mb-8">
                    <h1 className="text-4xl font-bold text-gray-900 dark:text-white mb-2">
                      {activeDivision.name}
                    </h1>
                    <p className="text-gray-600 dark:text-gray-400">
                      Your players are loaded and ready.
                    </p>
                  </div>

                  <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-6 mb-6">
                    <div className="flex items-center gap-3">
                      <svg className="w-8 h-8 text-green-600 dark:text-green-400" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12l2 2 4-4m6 2a9 9 0 11-18 0 9 9 0 0118 0z" />
                      </svg>
                      <div className="flex-1">
                        <h3 className="text-lg font-semibold text-green-800 dark:text-green-200">
                          {activeDivision.players.length} Players Loaded
                        </h3>
                        <p className="text-sm text-green-700 dark:text-green-300">
                          Continue to review and configure your draft, or import new data.
                        </p>
                      </div>
                    </div>
                    <button
                      onClick={() => setPhase('review')}
                      className="mt-4 w-full px-4 py-3 bg-green-600 hover:bg-green-700 text-white rounded-lg font-semibold flex items-center justify-center gap-2"
                    >
                      Continue to Review
                      <svg className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                    </button>
                  </div>

                  <div className="border-t border-gray-200 dark:border-gray-700 pt-6">
                    <p className="text-sm text-gray-500 dark:text-gray-400 mb-4 text-center">
                      Or start fresh with new player data:
                    </p>
                    <div className="grid grid-cols-2 gap-4">
                      <button
                        onClick={() => setImportMode('csv')}
                        className="px-4 py-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg hover:border-blue-500 dark:hover:border-blue-500 transition-colors text-gray-700 dark:text-gray-300 font-medium"
                      >
                        Import CSV
                      </button>
                      <button
                        onClick={() => setImportMode('excel')}
                        className="px-4 py-3 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg hover:border-green-500 dark:hover:border-green-500 transition-colors text-gray-700 dark:text-gray-300 font-medium"
                      >
                        Import Excel
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Import Type Selection - only when no data exists */}
            {!importMode && (activeDivision?.players.length ?? 0) === 0 && (
              <ImportTypeSelector
                onSelectCSV={() => setImportMode('csv')}
                onSelectExcel={() => setImportMode('excel')}
                onSelectDualCSV={() => setImportMode('dualcsv')}
              />
            )}

            {/* CSV Import Flow */}
            {importMode === 'csv' && (
              <FileUpload
                onCSVParsed={handleCSVParsed}
                onNext={() => setPhase('mapping')}
                existingPlayerCount={activeDivision?.players.length ?? 0}
                onContinueWithExisting={() => setPhase('review')}
              />
            )}

            {/* Excel Evaluation Import Flow */}
            {importMode === 'excel' && (
              <EvaluationImport
                teamCount={activeDivision?.teamCount ?? 8}
                initialTeamNames={activeDivision?.teams.map(t => t.headCoach || '')}
                initialAssistantCoaches={activeDivision?.teams.map(t => t.assistantCoach || '')}
                onComplete={handleEvaluationComplete}
                onCancel={() => setImportMode(null)}
              />
            )}

            {/* Dual CSV Import Flow (Evaluation + Registration) */}
            {importMode === 'dualcsv' && (
              <CSVImportFlow
                onComplete={(result: DualCSVImportResult) => {
                  // Store the CSV data for column mapping
                  setCSVData(result.evalCSVData);
                  // Store verification result for post-mapping processing
                  setDualCSVVerification({
                    excludedRowIndices: result.excludedRowIndices,
                    dnePlayers: result.dnePlayers,
                  });
                  setImportMode(null);
                  setPhase('mapping');
                }}
                onCancel={() => setImportMode(null)}
              />
            )}
          </div>
        )}

        {phase === 'mapping' && csvData && (
          <ColumnMapper csvData={csvData} onMappingComplete={handleMappingComplete} />
        )}

        {phase === 'review' && (
          <PlayerReview
            players={players}
            teams={teams}
            scoringMode={activeDivision.scoringMode}
            onScoringModeChange={handleScoringModeChange}
            onUpdatePlayer={handlePlayerUpdate}
            onUpdatePlayerField={updatePlayerField}
            onSetAllPlayers={setAllPlayers}
            onTeamsUpdate={setTeamsState}
            onLinkSiblings={linkSiblings}
            onUnlinkSibling={unlinkSibling}
            onNext={handleReviewComplete}
            onBack={() => handleGoBack('review')}
          />
        )}

        {phase === 'config' && (
          <DraftConfig
            teams={teams}
            players={players}
            divisionId={activeDivision?.id}
            rosterSize={activeDivision?.rosterSize || Math.ceil(players.length / teams.length) || 12}
            onConfigComplete={handleConfigComplete}
            onTeamsUpdate={async (updatedTeams) => {
              setTeams(updatedTeams);
              if (activeDivision && isApiMode()) {
                await saveTeamsToApi(activeDivision.id, updatedTeams);
              }
            }}
            onBack={() => handleGoBack('config')}
          />
        )}

        {phase === 'draft' && (draftState.currentTeamId || pendingComplete || draftState.isDraftComplete) && (
          <DraftBoard
            draftState={draftState}
            controls={{
              onDraftPlayer: draftPlayer,
              onSkipPick: skipPick,
              onUndo: undoLastPick,
              onReset: handleReset,
              pendingComplete,
              onFinalizeDraft: finalizeDraft,
              onCancelComplete: cancelPendingComplete,
            }}
            error={draftError}
            pendingRuleWarnings={pendingRuleWarnings}
            onClearRuleWarnings={clearPendingRuleWarnings}
            onConfirmOverride={confirmOverride}
            rosterSize={activeDivision?.rosterSize}
            enforceAgeLimit={activeDivision?.enforceAgeLimit ?? false}
            maxPerAge={activeDivision?.maxPerAge ?? 0}
            ageRange={activeDivision?.ageRange}
            isLoading={isLoading}
            mandatoryPickError={mandatoryPickError}
            onClearMandatoryPickError={clearMandatoryPickError}
          />
        )}

        {phase === 'draft' && !draftState.currentTeamId && !pendingComplete && !draftState.isDraftComplete && (
          <div className="min-h-screen bg-gray-50 dark:bg-gray-900 flex items-center justify-center p-4">
            <div className="text-center">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-4">
                Initializing Draft...
              </h2>
              <button
                onClick={() => setPhase('config')}
                className="px-4 py-2 bg-blue-500 hover:bg-blue-600 text-white rounded-lg"
              >
                Back to Configuration
              </button>
            </div>
          </div>
        )}

        {phase === 'complete' && (
          <div>
            {/* Back button - separate bar above content */}
            <div className="bg-gray-100 dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-2">
              <button
                onClick={handleBackToSelector}
                className="text-gray-500 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors text-sm flex items-center gap-1"
              >
                ← Back to Divisions
              </button>
            </div>
            <DraftComplete
              draftState={draftState}
              division={activeDivision}
              onReset={handleReset}
              onExecuteTrade={executeTrade}
              onUpdateTeam={handleUpdateTeam}
              onReturnToDraftBoard={returnToDraftBoard}
            />
          </div>
        )}
      </div>
    </>
  );
}

export default App;
