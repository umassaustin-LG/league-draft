import { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import { ChevronRight, ChevronLeft, ChevronDown, ChevronUp, CheckCircle, AlertCircle, Users, UserCheck, Loader2 } from 'lucide-react';
import { Team, Player, DraftFormat, DraftReadiness } from '../types';
import { api } from '../api/client';
import { SimulationModal } from './SimulationModal';
import { CoachKidPreviewGrid } from './CoachKidPreviewGrid';
import { getTeamDisplayName } from '../utils/teamUtils';

interface DraftConfigProps {
  teams: Team[];
  players: Player[];
  divisionId?: string;
  rosterSize: number;
  onConfigComplete: (draftFormat: DraftFormat, draftOrder: string[], resolvedPlayers: Player[]) => void;
  onTeamsUpdate?: (teams: Team[]) => Promise<void>;
  onBack?: () => void;
}

// Validation result for draft order
interface OrderValidation {
  valid: boolean;
  error?: string;
  duplicates: number[];
  missing: number[];
}

function validateDraftOrder(positions: (number | null)[], teamCount: number): OrderValidation {
  const validPositions = positions.filter((p): p is number => p !== null && p >= 1 && p <= teamCount);
  const expected = Array.from({ length: teamCount }, (_, i) => i + 1);

  // Find duplicates
  const seen = new Set<number>();
  const duplicates: number[] = [];
  for (const pos of validPositions) {
    if (seen.has(pos)) {
      duplicates.push(pos);
    }
    seen.add(pos);
  }

  // Find missing positions
  const missing = expected.filter(n => !validPositions.includes(n));

  if (duplicates.length > 0) {
    return { valid: false, error: `Duplicate position: ${duplicates[0]}`, duplicates, missing };
  }

  if (missing.length > 0) {
    return { valid: false, error: `Missing positions: ${missing.join(', ')}`, duplicates, missing };
  }

  return { valid: true, duplicates: [], missing: [] };
}

// Debounce delay for resorting after position changes (ms)
const SORT_DEBOUNCE_MS = 800;
// Debounce delay for auto-saving (ms)
const AUTO_SAVE_DEBOUNCE_MS = 1500;

export const DraftConfig = ({ teams, players, divisionId, rosterSize, onConfigComplete, onTeamsUpdate, onBack }: DraftConfigProps) => {
  const [readiness, setReadiness] = useState<DraftReadiness | null>(null);
  const [readinessError, setReadinessError] = useState<string | null>(null);
  const [readinessLoading, setReadinessLoading] = useState(false);
  const readinessRequest = useRef(0);
  const refreshReadiness = useCallback(async () => {
    const request = ++readinessRequest.current;
    setReadiness(null);
    if (!divisionId) return;
    setReadinessLoading(true);
    setReadinessError(null);
    try {
      const result = await api.getDraftReadiness(divisionId);
      if (request === readinessRequest.current) setReadiness(result);
    } catch {
      if (request === readinessRequest.current) setReadinessError('Readiness check unavailable. You can still start the draft.');
    } finally {
      if (request === readinessRequest.current) setReadinessLoading(false);
    }
  }, [divisionId]);
  useEffect(() => {
    void refreshReadiness();
    return () => { readinessRequest.current++; };
  }, [refreshReadiness, teams]);
  const [draftFormat, setDraftFormat] = useState<DraftFormat | null>(null);
  // Store position by team ID (immediate updates for input display)
  const [teamPositions, setTeamPositions] = useState<Record<string, number | null>>({});
  // Committed positions used for sorting (debounced updates)
  const [sortPositions, setSortPositions] = useState<Record<string, number | null>>({});
  const [showSimulation, setShowSimulation] = useState(false);
  const [showRulesPanel, setShowRulesPanel] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sortTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Compute resolved players with lockedToRound set for coach's kids with conflicts
  // This is a defensive fix to handle cases where lockedToRound wasn't set in PlayerReview
  const resolvedPlayers = useMemo(() => {
    // Group coach's kids by team
    const coachKidsByTeam: Record<string, Player[]> = {};
    players.filter(p => p.isCoachKid && p.coachTeamId).forEach(p => {
      const teamId = p.coachTeamId!;
      if (!coachKidsByTeam[teamId]) {
        coachKidsByTeam[teamId] = [];
      }
      coachKidsByTeam[teamId].push(p);
    });

    // Build round assignments for each team's coach kids
    const roundAssignments: Record<string, number> = {};

    for (const [, teamKids] of Object.entries(coachKidsByTeam)) {
      const assignedRounds = new Set<number>();

      // Sort by effective round (lockedToRound or projectedRound), then by score (descending) within each round
      const sortedKids = [...teamKids].sort((a, b) => {
        const aRound = a.lockedToRound ?? a.projectedRound;
        const bRound = b.lockedToRound ?? b.projectedRound;
        if (aRound !== bRound) {
          return aRound - bRound;
        }
        return b.totalScore - a.totalScore;
      });

      for (const kid of sortedKids) {
        // Use existing lockedToRound if set, otherwise projectedRound
        let targetRound = kid.lockedToRound ?? kid.projectedRound;
        // Find next available round
        while (assignedRounds.has(targetRound)) {
          targetRound++;
        }
        assignedRounds.add(targetRound);
        roundAssignments[kid.id] = targetRound;
      }
    }

    // Apply round assignments to players
    return players.map(player => {
      if (roundAssignments[player.id] !== undefined) {
        const newLockedRound = roundAssignments[player.id];
        // Only update if different from current or if not set
        if (player.lockedToRound !== newLockedRound) {
          return { ...player, lockedToRound: newLockedRound };
        }
      }
      return player;
    });
  }, [players]);

  // Initialize team positions from teams (use existing draftPosition if set)
  useEffect(() => {
    const initial: Record<string, number | null> = {};
    teams.forEach((team) => {
      // Use existing draftPosition if valid, otherwise null
      initial[team.id] = team.draftPosition > 0 ? team.draftPosition : null;
    });
    setTeamPositions(initial);
    setSortPositions(initial);
  }, [teams]);

  // Cleanup timeouts on unmount
  useEffect(() => {
    return () => {
      if (sortTimeoutRef.current) {
        clearTimeout(sortTimeoutRef.current);
      }
      if (saveTimeoutRef.current) {
        clearTimeout(saveTimeoutRef.current);
      }
    };
  }, []);

  // Load saved draft format from localStorage
  useEffect(() => {
    if (divisionId) {
      const savedFormat = localStorage.getItem(`draft-format-${divisionId}`);
      if (savedFormat && ['straight', 'snake', 'recalculated'].includes(savedFormat)) {
        setDraftFormat(savedFormat as DraftFormat);
      }
    }
  }, [divisionId]);

  // Auto-save teams when positions change (debounced)
  const saveTeamPositions = useCallback(async (positions: Record<string, number | null>) => {
    if (!onTeamsUpdate) return;

    // Build updated teams with new draft positions
    const updatedTeams = teams.map(team => ({
      ...team,
      draftPosition: positions[team.id] ?? 0,
    }));

    try {
      setIsSaving(true);
      await onTeamsUpdate(updatedTeams);
    } catch (err) {
      console.error('Failed to auto-save draft order:', err);
    } finally {
      setIsSaving(false);
    }
  }, [teams, onTeamsUpdate]);

  // Save draft format to localStorage when it changes
  const handleFormatChange = useCallback((format: DraftFormat) => {
    setDraftFormat(format);
    if (divisionId) {
      localStorage.setItem(`draft-format-${divisionId}`, format);
    }
  }, [divisionId]);

  const coachKids = resolvedPlayers.filter((p) => p.isCoachKid);

  // Check if all teams have at least 2 locked picks (coach's kids OR siblings locked to team)
  const canOrderByCoachKids = useMemo(() => {
    // Group locked picks by team (coach's kids assigned to team)
    const lockedByTeam: Record<string, Player[]> = {};
    teams.forEach(team => {
      lockedByTeam[team.id] = resolvedPlayers.filter(p => p.isCoachKid && p.coachTeamId === team.id);
    });
    // All teams must have at least 2 locked picks
    return teams.every(team => lockedByTeam[team.id].length >= 2);
  }, [teams, resolvedPlayers]);

  // Calculate locked pick scores for each team (sum of top 2 coach's kids by score)
  const teamLockedScores = useMemo(() => {
    const scores: Record<string, { score: number; kids: Array<{ name: string; score: number }> }> = {};
    teams.forEach(team => {
      const teamKids = resolvedPlayers
        .filter(p => p.isCoachKid && p.coachTeamId === team.id)
        .sort((a, b) => b.totalScore - a.totalScore) // Sort descending by score
        .slice(0, 2); // Take top 2

      const score = teamKids.reduce((sum, p) => sum + p.totalScore, 0);
      scores[team.id] = {
        score,
        kids: teamKids.map(p => ({ name: p.name, score: p.totalScore })),
      };
    });
    return scores;
  }, [teams, resolvedPlayers]);

  // Order teams by sum of top 2 coach's kids scores (lowest first)
  const handleOrderByCoachKids = () => {
    // Clear any pending timeouts
    if (sortTimeoutRef.current) {
      clearTimeout(sortTimeoutRef.current);
    }
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    // Calculate score for each team (sum of top 2 coach's kids by score)
    const teamScores: Array<{ id: string; score: number }> = teams.map(team => ({
      id: team.id,
      score: teamLockedScores[team.id]?.score ?? 0,
    }));

    // Sort by score ascending (lowest picks first)
    teamScores.sort((a, b) => a.score - b.score);

    // Assign positions 1 through N
    const newPositions: Record<string, number | null> = {};
    teamScores.forEach(({ id }, index) => {
      newPositions[id] = index + 1;
    });

    // Update both immediately
    setTeamPositions(newPositions);
    setSortPositions(newPositions);

    // Auto-save immediately for intentional action
    saveTeamPositions(newPositions);
  };

  // Find sibling groups (pairs of players linked as siblings)
  const siblingGroups = useMemo(() => {
    const groups: Array<{ player1: Player; player2: Player }> = [];
    const processed = new Set<string>();

    resolvedPlayers.forEach(player => {
      if (player.siblingId && !processed.has(player.id)) {
        const sibling = resolvedPlayers.find(p => p.id === player.siblingId);
        if (sibling) {
          groups.push({ player1: player, player2: sibling });
          processed.add(player.id);
          processed.add(sibling.id);
        }
      }
    });

    return groups;
  }, [resolvedPlayers]);

  // Convert positions to array for validation
  const positionsArray = useMemo(() => {
    return teams.map(t => teamPositions[t.id] ?? null);
  }, [teams, teamPositions]);

  // Validate the current order
  const validation = useMemo(() => {
    return validateDraftOrder(positionsArray, teams.length);
  }, [positionsArray, teams.length]);

  // Build the draft order from positions
  const draftOrder = useMemo(() => {
    if (!validation.valid) return [];

    // Create array of [teamId, position] pairs and sort by position
    const pairs = teams
      .map(t => ({ id: t.id, position: teamPositions[t.id] ?? 0 }))
      .filter(p => p.position > 0)
      .sort((a, b) => a.position - b.position);

    return pairs.map(p => p.id);
  }, [teams, teamPositions, validation.valid]);

  // Handle position change for a team (with debounced sorting and auto-save)
  const handlePositionChange = (teamId: string, value: string) => {
    const num = parseInt(value);
    const newPositions = {
      ...teamPositions,
      [teamId]: isNaN(num) ? null : num,
    };

    // Update input value immediately
    setTeamPositions(newPositions);

    // Debounce the sort update
    if (sortTimeoutRef.current) {
      clearTimeout(sortTimeoutRef.current);
    }
    sortTimeoutRef.current = setTimeout(() => {
      setSortPositions(newPositions);
    }, SORT_DEBOUNCE_MS);

    // Debounce the auto-save
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      saveTeamPositions(newPositions);
    }, AUTO_SAVE_DEBOUNCE_MS);
  };

  // Check if a position has a duplicate
  const isDuplicate = (position: number | null): boolean => {
    if (position === null) return false;
    return validation.duplicates.includes(position);
  };

  // Randomize draft order using Fisher-Yates shuffle
  const handleRandomizeOrder = () => {
    // Clear any pending timeouts
    if (sortTimeoutRef.current) {
      clearTimeout(sortTimeoutRef.current);
    }
    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }

    const teamIds = [...teams.map(t => t.id)];

    // Fisher-Yates shuffle
    for (let i = teamIds.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [teamIds[i], teamIds[j]] = [teamIds[j], teamIds[i]];
    }

    // Assign positions 1 through N
    const newPositions: Record<string, number | null> = {};
    teamIds.forEach((id, index) => {
      newPositions[id] = index + 1;
    });

    // Update both immediately for randomize (intentional action)
    setTeamPositions(newPositions);
    setSortPositions(newPositions);

    // Auto-save immediately for intentional action
    saveTeamPositions(newPositions);
  };

  const handleStart = () => {
    if (readiness?.ready === false) return;
    // Validate draft format is selected
    if (!draftFormat) {
      alert('Please select a draft format before starting.');
      return;
    }

    // Validate all coach kids are assigned
    const unassignedCoachKids = coachKids.filter(p => !p.coachTeamId);

    if (unassignedCoachKids.length > 0) {
      alert(`Please go back and assign all coach's kids to teams before starting the draft.\n\nUnassigned: ${unassignedCoachKids.map(p => p.name).join(', ')}`);
      return;
    }

    // Validate draft order
    if (!validation.valid) {
      alert(`Please fix the draft order: ${validation.error}`);
      return;
    }

    onConfigComplete(draftFormat, draftOrder, resolvedPlayers);
  };

  // Sort teams by their committed position for display (debounced)
  const sortedTeams = useMemo(() => {
    return [...teams].sort((a, b) => {
      const posA = sortPositions[a.id] ?? Infinity;
      const posB = sortPositions[b.id] ?? Infinity;
      return posA - posB;
    });
  }, [teams, sortPositions]);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-4">
      <div className="max-w-6xl mx-auto">
        <div className="flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 mb-6">
          <div>
            <h1 className="text-3xl font-bold text-gray-900 dark:text-white">Draft Configuration</h1>
            <p className="text-gray-600 dark:text-gray-400 mt-1">
              Set up teams, draft order, and format
            </p>
          </div>

          <div className="flex gap-2">
            {onBack && (
              <button
                onClick={onBack}
                className="px-4 py-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg font-medium flex items-center gap-2 transition-colors"
              >
                <ChevronLeft className="w-5 h-5" />
                Back to Review
              </button>
            )}
            <button
              onClick={() => setShowSimulation(true)}
              disabled={!validation.valid || !draftFormat}
              className={`px-4 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors ${
                validation.valid && draftFormat
                  ? 'bg-purple-500 hover:bg-purple-600 text-white'
                  : 'bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed'
              }`}
            >
              🔮 Run Simulation
            </button>
            <button
              onClick={handleStart}
              disabled={!validation.valid || !draftFormat || readiness?.ready === false}
              title={readiness?.ready === false ? 'Resolve readiness errors before starting' : undefined}
              className={`px-4 py-2 rounded-lg font-medium flex items-center gap-2 transition-colors ${
                validation.valid && draftFormat
                  ? 'bg-blue-500 hover:bg-blue-600 text-white'
                  : 'bg-gray-300 dark:bg-gray-700 text-gray-500 dark:text-gray-400 cursor-not-allowed'
              }`}
            >
              Start Draft
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        </div>

        <section className="bg-surface border border-rule rounded-sharp p-4 mb-6 text-ink" aria-label="Draft-day readiness">
          <div className="flex items-center justify-between mb-3">
            <h2 className="font-semibold">Draft-day readiness</h2>
            <button onClick={() => void refreshReadiness()} disabled={readinessLoading} className="text-sm text-brand disabled:opacity-50">{readinessLoading ? 'Checking…' : 'Refresh'}</button>
          </div>
          {readinessError && <p role="status" className="text-warn text-sm">{readinessError}</p>}
          {readiness?.checks.map(check => <div key={check.id} className="flex gap-3 py-2 border-t border-rule">
            {check.level === 'ok' ? <CheckCircle className="w-4 h-4 text-brand shrink-0 mt-1" /> : <AlertCircle className={`w-4 h-4 shrink-0 mt-1 ${check.level === 'error' ? 'text-alert' : 'text-warn'}`} />}
            <div><div className="font-medium text-sm">{check.title} <span className="text-xs text-ink-muted">{check.level}</span></div><p className="text-sm text-ink-muted">{check.detail}</p></div>
          </div>)}
          {readiness?.ready === false && <p className="text-alert text-sm mt-3">Resolve readiness errors before starting the draft.</p>}
        </section>

        {/* Draft Rules Summary - Collapsible */}
        {(coachKids.length > 0 || siblingGroups.length > 0) && (
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 mb-6">
            {/* Collapsible Header */}
            <button
              onClick={() => setShowRulesPanel(!showRulesPanel)}
              className="w-full px-4 py-3 flex items-center justify-between hover:bg-gray-50 dark:hover:bg-gray-700/50 transition-colors rounded-lg"
            >
              <div className="flex items-center gap-4 flex-wrap">
                <span className="font-semibold text-gray-900 dark:text-white">Draft Rules</span>

                {/* Coach's Kids Badge */}
                {coachKids.length > 0 && (
                  <span className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium ${
                    coachKids.every(p => p.coachTeamId)
                      ? 'bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-300'
                      : 'bg-orange-100 dark:bg-orange-900/30 text-orange-700 dark:text-orange-300'
                  }`}>
                    {coachKids.every(p => p.coachTeamId) ? (
                      <CheckCircle className="w-3.5 h-3.5" />
                    ) : (
                      <AlertCircle className="w-3.5 h-3.5" />
                    )}
                    <UserCheck className="w-3.5 h-3.5" />
                    {coachKids.length} Coach's Kid{coachKids.length !== 1 ? 's' : ''}
                  </span>
                )}

                {/* Sibling Groups Badge */}
                {siblingGroups.length > 0 && (
                  <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full text-xs font-medium bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300">
                    <Users className="w-3.5 h-3.5" />
                    {siblingGroups.length} Sibling Group{siblingGroups.length !== 1 ? 's' : ''}
                  </span>
                )}
              </div>

              {showRulesPanel ? (
                <ChevronUp className="w-5 h-5 text-gray-500 dark:text-gray-400" />
              ) : (
                <ChevronDown className="w-5 h-5 text-gray-500 dark:text-gray-400" />
              )}
            </button>

            {/* Expanded Content */}
            {showRulesPanel && (
              <div className="px-4 pb-4 pt-2 border-t border-gray-200 dark:border-gray-700">
                <div className="grid sm:grid-cols-2 gap-4">
                  {/* Coach's Kids Detail */}
                  {coachKids.length > 0 && (
                    <div className={`p-3 rounded-lg ${
                      coachKids.every(p => p.coachTeamId)
                        ? 'bg-green-50 dark:bg-green-900/20'
                        : 'bg-orange-50 dark:bg-orange-900/20'
                    }`}>
                      <div className={`text-sm font-medium mb-2 ${
                        coachKids.every(p => p.coachTeamId)
                          ? 'text-green-800 dark:text-green-200'
                          : 'text-orange-800 dark:text-orange-200'
                      }`}>
                        Coach's Kids
                      </div>
                      <div className="space-y-1">
                        {coachKids.map(player => {
                          const team = teams.find(t => t.id === player.coachTeamId);
                          const effectiveRound = player.lockedToRound ?? player.projectedRound;
                          const isBumped = player.lockedToRound && player.lockedToRound !== player.projectedRound;
                          return (
                            <div key={player.id} className={`text-xs ${
                              player.coachTeamId
                                ? 'text-green-700 dark:text-green-300'
                                : 'text-orange-700 dark:text-orange-300'
                            }`}>
                              {player.name} → {team ? getTeamDisplayName(team) : <span className="italic">Unassigned</span>} (R{effectiveRound}{isBumped && '*'})
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}

                  {/* Sibling Groups Detail */}
                  {siblingGroups.length > 0 && (
                    <div className="p-3 rounded-lg bg-purple-50 dark:bg-purple-900/20">
                      <div className="text-sm font-medium text-purple-800 dark:text-purple-200 mb-2">
                        Sibling Groups
                      </div>
                      <div className="space-y-1">
                        {siblingGroups.map(({ player1, player2 }) => (
                          <div key={`${player1.id}-${player2.id}`} className="text-xs text-purple-700 dark:text-purple-300">
                            {player1.name} ↔ {player2.name}
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {/* Warning for unassigned coach's kids */}
                {coachKids.some(p => !p.coachTeamId) && (
                  <div className="mt-3 p-2 bg-orange-100 dark:bg-orange-900/30 border border-orange-200 dark:border-orange-800 rounded text-xs text-orange-700 dark:text-orange-300">
                    <AlertCircle className="w-3.5 h-3.5 inline mr-1" />
                    Go back to Review to assign coach's kids before starting draft
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="grid lg:grid-cols-2 gap-4">
          {/* Draft Format */}
          <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
            <h2 className="text-lg font-semibold text-gray-900 dark:text-white mb-3">
              Draft Format
            </h2>
            <div className="space-y-2">
              {[
                { value: 'straight', label: 'Straight', desc: '1-8, 1-8, 1-8...' },
                { value: 'snake', label: 'Snake', desc: '1-8, 8-1, 1-8, 8-1...' },
                { value: 'recalculated', label: 'Recalculated', desc: 'Lowest score picks first each round' },
              ].map((format) => (
                <label
                  key={format.value}
                  className="flex items-center gap-2 px-2 py-1.5 border border-gray-200 dark:border-gray-600 rounded cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  <input
                    type="radio"
                    name="format"
                    value={format.value}
                    checked={draftFormat === format.value}
                    onChange={(e) => handleFormatChange(e.target.value as DraftFormat)}
                    className="accent-blue-600"
                  />
                  <div className="flex items-baseline gap-2">
                    <span className="text-sm font-medium text-gray-900 dark:text-white">{format.label}</span>
                    <span className="text-xs text-gray-500 dark:text-gray-400">{format.desc}</span>
                  </div>
                </label>
              ))}
            </div>
          </div>

          {/* Draft Order */}
          <div className="bg-white dark:bg-gray-800 rounded-lg p-4 border border-gray-200 dark:border-gray-700">
            <div className="flex justify-between items-center mb-2">
              <div className="flex items-center gap-2">
                <h2 className="text-lg font-semibold text-gray-900 dark:text-white">
                  Draft Order
                </h2>
                {isSaving && (
                  <span className="flex items-center gap-1 text-xs text-gray-500 dark:text-gray-400">
                    <Loader2 className="w-3 h-3 animate-spin" />
                    Saving...
                  </span>
                )}
              </div>
              <div className="inline-flex rounded-md border border-gray-300 dark:border-gray-600 overflow-hidden">
                {canOrderByCoachKids && (
                  <button
                    onClick={handleOrderByCoachKids}
                    className="px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 border-r border-gray-300 dark:border-gray-600 transition-colors"
                    title="Order by sum of top 2 coach's kids scores (lowest first)"
                  >
                    Locked Pick Rank
                  </button>
                )}
                <button
                  onClick={handleRandomizeOrder}
                  className="px-3 py-1.5 text-xs font-medium text-gray-700 dark:text-gray-300 bg-white dark:bg-gray-800 hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
                >
                  Randomize
                </button>
              </div>
            </div>
            <p className="text-xs text-gray-600 dark:text-gray-400 mb-2">
              Position 1 picks first in round 1.
            </p>

            {/* Validation Error */}
            {!validation.valid && (
              <div className="mb-2 p-2 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded flex items-center gap-2">
                <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-400 flex-shrink-0" />
                <span className="text-xs text-red-700 dark:text-red-300">{validation.error}</span>
              </div>
            )}

            <div className="space-y-1">
              {sortedTeams.map((team) => {
                const position = teamPositions[team.id];
                const teamCoachKids = resolvedPlayers.filter(p => p.coachTeamId === team.id);
                const hasError = isDuplicate(position) || (position !== null && (position < 1 || position > teams.length));
                const lockedScore = teamLockedScores[team.id];

                return (
                  <div
                    key={team.id}
                    className={`flex items-center gap-2 px-2 py-1.5 rounded transition-colors ${
                      hasError
                        ? 'bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800'
                        : 'bg-gray-50 dark:bg-gray-700'
                    }`}
                  >
                    <input
                      type="number"
                      min="1"
                      max={teams.length}
                      value={position ?? ''}
                      onChange={(e) => handlePositionChange(team.id, e.target.value)}
                      className={`w-12 px-2 py-1 text-center border rounded font-semibold ${
                        hasError
                          ? 'border-red-500 bg-red-50 dark:bg-red-900/30 text-red-700 dark:text-red-300'
                          : 'border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-800 text-gray-900 dark:text-white'
                      } focus:ring-2 focus:ring-blue-500 focus:border-transparent`}
                    />
                    <div className="flex-1 min-w-0">
                      <span className="text-sm text-gray-900 dark:text-white font-medium">{getTeamDisplayName(team)}</span>
                      {teamCoachKids.length > 0 && (
                        <span className="ml-2 text-xs text-gray-500 dark:text-gray-400 hidden sm:inline">
                          ({teamCoachKids.map(p => p.name).join(', ')})
                        </span>
                      )}
                    </div>
                    {/* Show locked score breakdown */}
                    {canOrderByCoachKids && lockedScore && (
                      <div className="text-right hidden sm:block">
                        <span className="text-sm font-semibold text-gray-700 dark:text-gray-300 tabular-nums">
                          {lockedScore.score.toFixed(1)}
                        </span>
                        <span className="text-xs text-gray-400 dark:text-gray-500 ml-1">
                          ({lockedScore.kids.map(k => k.score.toFixed(1)).join(' + ')})
                        </span>
                      </div>
                    )}
                    {hasError && isDuplicate(position) && (
                      <span className="text-xs text-red-600 dark:text-red-400">
                        Dup
                      </span>
                    )}
                  </div>
                );
              })}
            </div>

            {/* Valid Order Preview */}
            {validation.valid && (
              <div className="mt-2 pt-2 border-t border-gray-200 dark:border-gray-700">
                <p className="text-xs text-gray-600 dark:text-gray-400">
                  <span className="font-medium text-gray-700 dark:text-gray-300">Order: </span>
                  {draftOrder.map(id => {
                    const team = teams.find(t => t.id === id);
                    return team ? getTeamDisplayName(team) : 'Unknown';
                  }).join(' → ')}
                </p>
              </div>
            )}
          </div>
        </div>

        {/* Coach's Kid Preview Grid */}
        {validation.valid && coachKids.length > 0 && (
          <div className="mt-6">
            <CoachKidPreviewGrid
              teams={teams}
              players={resolvedPlayers}
              draftOrder={draftOrder}
              rosterSize={rosterSize}
            />
          </div>
        )}
      </div>

      {/* Simulation Modal */}
      {showSimulation && draftFormat && (
        <SimulationModal
          players={resolvedPlayers}
          teams={teams}
          draftOrder={draftOrder}
          draftFormat={draftFormat}
          onClose={() => setShowSimulation(false)}
        />
      )}
    </div>
  );
};
