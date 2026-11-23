import { useState, useCallback, useEffect, useRef } from 'react';
import {
  ArrowLeft,
  Wand2,
  Upload,
  Users,
  BarChart3,
  Check,
  Settings,
  Play,
  ArrowLeftRight,
  Search,
  ClipboardCheck,
} from 'lucide-react';
import { Division, Player, Team, ResolvedRequest, RequestsFirstConfig, DEFAULT_REQUESTS_FIRST_CONFIG, TradeCandidate, AppPhase } from '../types';
import { RegistrationRecord } from '../types/evaluation';
import { EvaluationImport } from './evaluation';
import { NameMatchResolver, TeamBuilderResults, RequestConfirmation, TradeSuggestions } from './teamBuilder';
import { TradeModal } from './TradeModal';
import { TeamRosters } from './TeamRosters';
import {
  runTeamBuilderAlgorithm,
  runRequestsFirstAlgorithm,
  TeamBuilderConfig,
  TeamBuilderResult,
  RequestsFirstResult,
  TeamBuilderPlayer,
  DEFAULT_TEAM_BUILDER_CONFIG,
  applyAssignments,
} from '../utils/teamBuilderAlgorithm';
import {
  RegistrationData,
  parseRegistrationDataTab,
  matchRegistrationToEval,
  detectSiblingsByAddress,
  CoachInfo,
  PlayerMatch,
  normalizeRequestData,
  NormalizationResult,
  prepareRequestsForConfirmation,
} from '../utils/teamBuilderParser';
import * as XLSX from 'xlsx';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

type TeamBuilderStep = 'setup' | 'import' | 'resolution' | 'confirm-requests' | 'configure' | 'generate' | 'results';

type AlgorithmMode = 'balance-first' | 'requests-first';

interface TeamBuilderFlowProps {
  division: Division;
  onBack: () => void;
  onComplete?: (players: Player[], teams: Team[]) => void;
  onUpdateTeams?: (teams: Team[]) => void;
  onUpdatePlayers?: (players: Player[]) => void;
  onUpdatePhase?: (phase: AppPhase) => void;
}

interface RegistrationPlayer {
  registrationIndex: number;
  firstName: string;
  lastName: string;
  fullName: string;
  coachRequest: string;
  teammateRequests: string[];
  school: string;
  grade: number | null;
  address: string;
  littleLeagueAge: number | null;
  match: PlayerMatch;
  evalBib: string | null;
}

// -----------------------------------------------------------------------------
// Component
// -----------------------------------------------------------------------------

export const TeamBuilderFlow = ({ division, onBack, onComplete, onUpdateTeams, onUpdatePlayers, onUpdatePhase: _onUpdatePhase }: TeamBuilderFlowProps) => {
  // Determine initial step based on division state
  const getInitialStep = (): TeamBuilderStep => {
    // If we have players with team assignments (results), go to results
    if (division.players.length > 0 && division.players.some(p => p.draftedByTeamId)) {
      return 'results';
    }
    // If we have players but no assignments, go to configure (ready to generate)
    if (division.players.length > 0) {
      return 'configure';
    }
    // If teams have coach names, go to import
    if (division.teams.some(t => t.headCoach)) {
      return 'import';
    }
    // Otherwise start fresh
    return 'setup';
  };

  const [step, setStep] = useState<TeamBuilderStep>(getInitialStep);

  // Import data - initialize from division if available
  const [evalPlayers, setEvalPlayers] = useState<Player[]>(division.players);
  const [teams, setTeams] = useState<Team[]>(division.teams);
  const [registrationData, setRegistrationData] = useState<RegistrationData | null>(null);
  const [registrationPlayers, setRegistrationPlayers] = useState<RegistrationPlayer[]>([]);

  // Resolution state
  const [unmatchedPlayers, setUnmatchedPlayers] = useState<RegistrationPlayer[]>([]);

  // Algorithm config
  const [config, setConfig] = useState<TeamBuilderConfig>(() => ({
    ...DEFAULT_TEAM_BUILDER_CONFIG,
    maxRosterSize: Math.max(
      DEFAULT_TEAM_BUILDER_CONFIG.maxRosterSize,
      division.rosterSize,
      Math.ceil(division.players.length / Math.max(1, division.teams.length)),
      ...division.teams.map(team => team.roster.length)
    ),
  }));

  // Normalization result (from request resolution step)
  const [normalizationResult, setNormalizationResult] = useState<NormalizationResult | null>(null);

  // Results - initialize from division if we have results (players with team assignments)
  const hasResults = division.players.length > 0 && division.players.some(p => p.draftedByTeamId);
  const [algorithmResult, setAlgorithmResult] = useState<TeamBuilderResult | null>(null);
  const [requestsFirstResult, setRequestsFirstResult] = useState<RequestsFirstResult | null>(null);
  const [finalPlayers, setFinalPlayers] = useState<Player[]>(hasResults ? division.players : []);
  const [finalTeams, setFinalTeams] = useState<Team[]>(hasResults ? division.teams : []);

  // Swap modal
  const [showSwapModal, setShowSwapModal] = useState(false);

  // Request confirmation state
  const [resolvedRequests, setResolvedRequests] = useState<ResolvedRequest[]>([]);
  const [algorithmMode, setAlgorithmMode] = useState<AlgorithmMode>('requests-first');
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [requestsFirstConfig, _setRequestsFirstConfig] = useState<RequestsFirstConfig>(DEFAULT_REQUESTS_FIRST_CONFIG);

  // Trade suggestions state
  const [appliedTradeIds, setAppliedTradeIds] = useState<Set<string>>(new Set());
  const [dismissedTradeIds, setDismissedTradeIds] = useState<Set<string>>(new Set());

  // Player search for debugging request resolution
  const [playerSearchQuery, setPlayerSearchQuery] = useState('');

  // Track if we initiated the last teams update to prevent sync loops
  const isLocalUpdate = useRef(false);

  // Sync teams state when division.teams changes from parent (not from us)
  // This ensures we always reflect the saved state when navigating back
  useEffect(() => {
    if (isLocalUpdate.current) {
      // We initiated this update, don't sync back
      isLocalUpdate.current = false;
      return;
    }
    // External update (e.g., navigating back) - sync from parent
    setTeams(division.teams);
  }, [division.teams]);

  // -----------------------------------------------------------------------------
  // Step 1: Import
  // -----------------------------------------------------------------------------

  // Helper to convert RegistrationRecord to RegistrationData format
  const convertRegistrationRecords = useCallback((
    records: RegistrationRecord[],
    evalPlayerList: { bib: string; firstName: string; lastName: string }[]
  ) => {
    // Convert to RegistrationData format expected by teamBuilderParser
    const rows = records.map(r => ({
      firstName: r.firstName,
      lastName: r.lastName,
      fullName: `${r.firstName} ${r.lastName}`,
      coachRequest: r.coachRequest || '',
      teammateRequests: r.teammateRequests || [],
      school: r.school || '',
      grade: r.grade ?? null,
      address: r.address || '',
      littleLeagueAge: r.littleLeagueAge ?? null,
      rawTeammateRequestsString: (r.teammateRequests || []).join(', '),
    }));

    setRegistrationData({ rows, headers: [], warnings: [] });

    // Match registration to eval data
    const matched: RegistrationPlayer[] = rows.map((row, index) => {
      const match = matchRegistrationToEval(
        { ...row, fullName: `${row.firstName} ${row.lastName}` },
        evalPlayerList
      );
      match.registrationIndex = index;

      return {
        registrationIndex: index,
        firstName: row.firstName,
        lastName: row.lastName,
        fullName: row.fullName,
        coachRequest: row.coachRequest,
        teammateRequests: row.teammateRequests,
        school: row.school,
        grade: row.grade,
        address: row.address,
        littleLeagueAge: row.littleLeagueAge,
        match,
        evalBib: match.evalBib,
      };
    });

    setRegistrationPlayers(matched);
    setUnmatchedPlayers(matched.filter(p => p.match.matchType === 'none'));

    console.log(`Converted ${records.length} registration records, ${matched.filter(p => p.match.matchType !== 'none').length} matched`);
  }, []);

  const handleEvalImportComplete = useCallback((
    players: Player[],
    teamNames: string[],
    assistantCoaches: string[],
    parsedRegistrationData?: RegistrationRecord[]
  ) => {
    setEvalPlayers(players);

    // Update teams with coach info from eval import
    // IMPORTANT: Preserve existing coach names if they were already set in Setup step
    // Note: teamNames from evaluation actually contains head coach names, not actual team names
    const updatedTeams = teams.map((team, index) => ({
      ...team,
      // headCoach is the manager's last name - only update if not already set
      headCoach: team.headCoach || teamNames[index] || '',
      assistantCoach: team.assistantCoach || assistantCoaches[index] || '',
      // teamName stays empty until actual team name (e.g., "Guardians") is assigned
    }));
    setTeams(updatedTeams);

    // Persist the updated teams and players (mark as local update to prevent sync loop)
    isLocalUpdate.current = true;
    if (onUpdateTeams) {
      onUpdateTeams(updatedTeams);
    }
    if (onUpdatePlayers) {
      onUpdatePlayers(players);
    }

    // If registration data was parsed from the same Excel file, process it
    if (parsedRegistrationData && parsedRegistrationData.length > 0) {
      const evalPlayerList = players.map(p => ({
        bib: p.bib,
        firstName: p.firstName,
        lastName: p.lastName,
      }));
      convertRegistrationRecords(parsedRegistrationData, evalPlayerList);
      console.log(`Auto-loaded ${parsedRegistrationData.length} registration records from Excel`);
    }

    // Move to resolution step
    setStep('resolution');
  }, [teams, convertRegistrationRecords, onUpdateTeams, onUpdatePlayers]);

  // Handle Registration Data file upload (separate from eval)
  const handleRegistrationFileUpload = useCallback(async (file: File) => {
    try {
      const data = await file.arrayBuffer();
      const workbook = XLSX.read(data, { type: 'array' });

      // Find Registration Data tab
      const regTabName = workbook.SheetNames.find(name =>
        name.toLowerCase().includes('registration')
      );

      if (!regTabName) {
        alert('No "Registration Data" tab found in the Excel file');
        return;
      }

      const sheet = workbook.Sheets[regTabName];
      const parsed = parseRegistrationDataTab(sheet, regTabName);

      if (!parsed) {
        alert('Failed to parse Registration Data tab');
        return;
      }

      setRegistrationData(parsed);

      // Match registration to eval data
      const evalPlayerList = evalPlayers.map(p => ({
        bib: p.bib,
        firstName: p.firstName,
        lastName: p.lastName,
      }));

      const matched: RegistrationPlayer[] = parsed.rows.map((row, index) => {
        const match = matchRegistrationToEval(
          { ...row, fullName: `${row.firstName} ${row.lastName}` },
          evalPlayerList
        );
        match.registrationIndex = index;

        return {
          registrationIndex: index,
          firstName: row.firstName,
          lastName: row.lastName,
          fullName: row.fullName,
          coachRequest: row.coachRequest,
          teammateRequests: row.teammateRequests,
          school: row.school,
          grade: row.grade,
          address: row.address,
          littleLeagueAge: row.littleLeagueAge,
          match,
          evalBib: match.evalBib,
        };
      });

      setRegistrationPlayers(matched);
      setUnmatchedPlayers(matched.filter(p => p.match.matchType === 'none'));

    } catch (error) {
      console.error('Failed to parse registration file:', error);
      alert('Failed to parse the Excel file');
    }
  }, [evalPlayers]);

  // -----------------------------------------------------------------------------
  // Step 2: Resolution
  // -----------------------------------------------------------------------------

  const handleNameResolve = useCallback((registrationIndex: number, evalBib: string | null) => {
    setRegistrationPlayers(prev => prev.map(p => {
      if (p.registrationIndex === registrationIndex) {
        return { ...p, evalBib, match: { ...p.match, evalBib, matchType: evalBib ? 'exact' : 'none' } };
      }
      return p;
    }));

    // Update unmatched list
    setUnmatchedPlayers(prev => prev.filter(p => p.registrationIndex !== registrationIndex));
  }, []);

  // Create a DNE player with 0 scores from registration data
  const handleCreateDNEPlayer = useCallback((registrationIndex: number) => {
    const regPlayer = registrationPlayers.find(p => p.registrationIndex === registrationIndex);
    if (!regPlayer) return;

    // Create a new player with 0 scores and DNE flag
    const newPlayer: Player = {
      id: `dne-${registrationIndex}-${Date.now()}`,
      bib: `DNE-${registrationIndex}`,
      firstName: regPlayer.firstName,
      lastName: regPlayer.lastName,
      name: `${regPlayer.firstName} ${regPlayer.lastName}`,

      // All raw scores are 0 for DNE players
      fieldScore: 0,
      throwScore: 0,
      hitPower: 0,
      hitForm: 0,
      hitContact: 0,
      pitchingStrength: 0,
      pitchingForm: 0,
      catchScore: 0,
      runningScore: 0,

      // All subtotals are 0
      fieldingSubtotal: 0,
      hittingSubtotal: 0,
      pitchingSubtotal: 0,
      subjectiveTotal: 0,
      objectiveTotal: 0,
      officialAdjust: 0,

      totalScore: 0,
      rank: evalPlayers.length + 1, // Will be last
      projectedRound: Math.ceil((evalPlayers.length + 1) / teams.length),

      // Player info
      littleLeagueAge: regPlayer.littleLeagueAge ?? 0, // 0 indicates unknown age
      birthday: '',
      isAllStar: false,
      isDNE: true, // Mark as Did Not Evaluate

      // Draft rules
      isCoachKid: false,
      isDrafted: false,

      // Registration data
      coachRequest: regPlayer.coachRequest || undefined,
      teammateRequests: regPlayer.teammateRequests.length > 0 ? regPlayer.teammateRequests : undefined,
      school: regPlayer.school || undefined,
      grade: regPlayer.grade ?? undefined,
    };

    // Add to eval players
    setEvalPlayers(prev => [...prev, newPlayer]);

    // Update registration player to point to this new bib
    setRegistrationPlayers(prev => prev.map(p => {
      if (p.registrationIndex === registrationIndex) {
        return { ...p, evalBib: newPlayer.bib, match: { ...p.match, evalBib: newPlayer.bib, matchType: 'exact' } };
      }
      return p;
    }));

    // Remove from unmatched
    setUnmatchedPlayers(prev => prev.filter(p => p.registrationIndex !== registrationIndex));
  }, [registrationPlayers, evalPlayers.length, teams.length]);

  const handleProceedToConfirmRequests = useCallback(() => {
    // Detect siblings by address before proceeding
    if (registrationData) {
      const siblingGroups = detectSiblingsByAddress(registrationData.rows);
      // Store sibling info for algorithm (would be added to player data)
      console.log('Detected sibling groups:', siblingGroups);
    }

    // Run normalization to resolve all requests
    const coachInfos: CoachInfo[] = teams.map(t => ({
      teamId: t.id,
      teamName: t.teamName || t.headCoach,
      coachName: t.headCoach,
      assistantCoach: t.assistantCoach,
    }));

    // Build player data for normalization by merging eval and registration
    const playersForNormalization = evalPlayers.map(evalPlayer => {
      const regPlayer = registrationPlayers.find(r => r.evalBib === evalPlayer.bib);
      return {
        id: evalPlayer.id,
        bib: evalPlayer.bib,
        firstName: evalPlayer.firstName,
        lastName: evalPlayer.lastName,
        coachRequest: regPlayer?.coachRequest ?? evalPlayer.coachRequest,
        teammateRequests: regPlayer?.teammateRequests ?? evalPlayer.teammateRequests,
        school: regPlayer?.school ?? evalPlayer.school,
      };
    });

    const normResult = normalizeRequestData(playersForNormalization, coachInfos);
    setNormalizationResult(normResult);

    console.log('Normalization result:', normResult.stats);
    if (normResult.warnings.length > 0) {
      console.log('Normalization warnings:', normResult.warnings);
    }

    // Prepare resolved requests for confirmation UI
    const preparedRequests = prepareRequestsForConfirmation(normResult, requestsFirstConfig);
    setResolvedRequests(preparedRequests);

    // Go to request confirmation step
    setStep('confirm-requests');
  }, [registrationData, evalPlayers, registrationPlayers, teams, requestsFirstConfig]);

  // Handle updating a request from the confirmation UI
  const handleUpdateRequest = useCallback((
    requestId: string,
    targetId: string | null,
    targetName: string | null
  ) => {
    setResolvedRequests(prev => prev.map(req => {
      if (req.id !== requestId) return req;

      if (targetId === null) {
        return {
          ...req,
          status: 'unresolvable' as const,
          resolvedTargetId: null,
          resolvedTargetName: null,
        };
      }

      return {
        ...req,
        status: 'user-confirmed' as const,
        resolvedTargetId: targetId,
        resolvedTargetName: targetName,
      };
    }));
  }, []);

  // Proceed from request confirmation to configure
  const handleProceedToConfigure = useCallback(() => {
    setStep('configure');
  }, []);

  // -----------------------------------------------------------------------------
  // Step 3: Configure
  // -----------------------------------------------------------------------------

  const handleUpdateTeam = useCallback((teamId: string, updates: Partial<Team>) => {
    setTeams(prev => {
      const updated = prev.map(t =>
        t.id === teamId ? { ...t, ...updates } : t
      );
      // Mark this as a local update so the useEffect doesn't sync back
      isLocalUpdate.current = true;
      // Persist to division immediately
      if (onUpdateTeams) {
        onUpdateTeams(updated);
      }
      return updated;
    });
  }, [onUpdateTeams]);

  const handleProceedToGenerate = useCallback(() => {
    // Save teams before proceeding (mark as local update to prevent sync loop)
    if (onUpdateTeams) {
      isLocalUpdate.current = true;
      onUpdateTeams(teams);
    }
    setStep('generate');
  }, [onUpdateTeams, teams]);

  // -----------------------------------------------------------------------------
  // Step 4: Generate
  // -----------------------------------------------------------------------------

  const handleRunAlgorithm = useCallback(() => {
    // Create mapping from evaluation team IDs (team-0, team-1, etc.) to actual division team IDs
    const evalTeamIdToRealId = new Map<string, string>();
    teams.forEach((team, index) => {
      evalTeamIdToRealId.set(`team-${index}`, team.id);
    });

    // Build normalized player map for quick lookup
    const normalizedPlayerMap = new Map(
      normalizationResult?.players.map(p => [p.id, p]) || []
    );

    // Build enhanced players using normalization results
    const teamBuilderPlayers: TeamBuilderPlayer[] = evalPlayers.map(evalPlayer => {
      // Find matching registration data
      const regPlayer = registrationPlayers.find(r => r.evalBib === evalPlayer.bib);

      // Get normalized request data
      const normalized = normalizedPlayerMap.get(evalPlayer.id);

      // Extract two-way and one-way teammate IDs from normalization
      const twoWayTeammateIds: string[] = [];
      const oneWayTeammateIds: string[] = [];

      if (normalized) {
        for (const resolution of normalized.teammateResolutions) {
          if (resolution.resolvedPlayerId) {
            if (resolution.isTwoWay) {
              twoWayTeammateIds.push(resolution.resolvedPlayerId);
            } else {
              oneWayTeammateIds.push(resolution.resolvedPlayerId);
            }
          }
        }
      }

      // Remap coachTeamId from eval format (team-0, team-1) to actual division team ID
      const remappedCoachTeamId = evalPlayer.coachTeamId
        ? evalTeamIdToRealId.get(evalPlayer.coachTeamId) || evalPlayer.coachTeamId
        : undefined;

      return {
        ...evalPlayer,
        // Use registration Little League Age if available, otherwise keep eval age
        littleLeagueAge: regPlayer?.littleLeagueAge ?? evalPlayer.littleLeagueAge,
        // Remap coach team ID to actual division team ID
        coachTeamId: remappedCoachTeamId,
        coachRequest: normalized?.rawCoachRequest ?? regPlayer?.coachRequest ?? evalPlayer.coachRequest,
        teammateRequests: normalized?.rawTeammateRequests ?? regPlayer?.teammateRequests ?? evalPlayer.teammateRequests,
        school: normalized?.normalizedSchool ?? regPlayer?.school ?? evalPlayer.school,
        grade: regPlayer?.grade ?? evalPlayer.grade,
        // Use pre-resolved values from normalization
        resolvedCoachTeamId: normalized?.resolvedCoachTeamId || null,
        resolvedTeammateIds: normalized?.resolvedTeammateIds || [],
        twoWayTeammateIds,
        oneWayTeammateIds,
      };
    });

    if (algorithmMode === 'requests-first') {
      // Run requests-first algorithm
      const result = runRequestsFirstAlgorithm(
        teamBuilderPlayers,
        teams,
        resolvedRequests,
        {
          ...requestsFirstConfig,
          maxRosterSize: config.maxRosterSize,
          minRosterSize: config.minRosterSize,
          forceEvenTeams: config.forceEvenTeams,
        }
      );
      setRequestsFirstResult(result);
      setAlgorithmResult(result);

      // Reset trade state
      setAppliedTradeIds(new Set());
      setDismissedTradeIds(new Set());

      // Apply assignments to get final state
      const { players: updatedPlayers, teams: updatedTeams } = applyAssignments(
        teamBuilderPlayers,
        teams,
        result.assignments
      );

      setFinalPlayers(updatedPlayers);
      setFinalTeams(updatedTeams);

      // Persist the results
      if (onUpdatePlayers) {
        onUpdatePlayers(updatedPlayers);
      }
      if (onUpdateTeams) {
        onUpdateTeams(updatedTeams);
      }
    } else {
      // Run balance-first algorithm (original)
      const result = runTeamBuilderAlgorithm(teamBuilderPlayers, teams, config);
      setAlgorithmResult(result);
      setRequestsFirstResult(null);

      // Apply assignments to get final state
      const { players: updatedPlayers, teams: updatedTeams } = applyAssignments(
        teamBuilderPlayers,
        teams,
        result.assignments
      );

      setFinalPlayers(updatedPlayers);
      setFinalTeams(updatedTeams);

      // Persist the results
      if (onUpdatePlayers) {
        onUpdatePlayers(updatedPlayers);
      }
      if (onUpdateTeams) {
        onUpdateTeams(updatedTeams);
      }
    }

    setStep('results');
  }, [evalPlayers, teams, registrationPlayers, config, normalizationResult, algorithmMode, resolvedRequests, requestsFirstConfig, onUpdatePlayers, onUpdateTeams]);

  // Handle applying a suggested trade
  const handleApplyTrade = useCallback((trade: TradeCandidate) => {
    if (!requestsFirstResult) return;

    // Mark trade as applied
    setAppliedTradeIds(prev => new Set([...prev, trade.id]));

    // Update final players and teams
    setFinalPlayers(prev => prev.map(p => {
      if (p.id === trade.player1Id) {
        return { ...p, draftedByTeamId: trade.toTeamId };
      }
      if (p.id === trade.player2Id) {
        return { ...p, draftedByTeamId: trade.fromTeamId };
      }
      return p;
    }));

    setFinalTeams(prev => prev.map(team => {
      if (team.id === trade.fromTeamId) {
        // Remove player1, add player2
        const player1 = finalPlayers.find(p => p.id === trade.player1Id);
        const player2 = finalPlayers.find(p => p.id === trade.player2Id);
        if (!player1 || !player2) return team;

        const newRoster = team.roster.filter(p => p.id !== trade.player1Id);
        newRoster.push({ ...player2, draftedByTeamId: trade.fromTeamId });
        const newTotalScore = newRoster.reduce((sum, p) => sum + p.totalScore, 0);
        return { ...team, roster: newRoster, totalScore: newTotalScore };
      }
      if (team.id === trade.toTeamId) {
        // Remove player2, add player1
        const player1 = finalPlayers.find(p => p.id === trade.player1Id);
        const player2 = finalPlayers.find(p => p.id === trade.player2Id);
        if (!player1 || !player2) return team;

        const newRoster = team.roster.filter(p => p.id !== trade.player2Id);
        newRoster.push({ ...player1, draftedByTeamId: trade.toTeamId });
        const newTotalScore = newRoster.reduce((sum, p) => sum + p.totalScore, 0);
        return { ...team, roster: newRoster, totalScore: newTotalScore };
      }
      return team;
    }));
  }, [requestsFirstResult, finalPlayers]);

  // Handle applying all suggested trades
  const handleApplyAllTrades = useCallback(() => {
    if (!requestsFirstResult) return;

    const pendingTrades = requestsFirstResult.suggestedTrades.filter(
      t => !appliedTradeIds.has(t.id) && !dismissedTradeIds.has(t.id)
    );

    for (const trade of pendingTrades) {
      handleApplyTrade(trade);
    }
  }, [requestsFirstResult, appliedTradeIds, dismissedTradeIds, handleApplyTrade]);

  // Handle dismissing a trade
  const handleDismissTrade = useCallback((tradeId: string) => {
    setDismissedTradeIds(prev => new Set([...prev, tradeId]));
  }, []);

  // -----------------------------------------------------------------------------
  // Step 5: Results
  // -----------------------------------------------------------------------------

  const handleRerun = useCallback(() => {
    if (!algorithmResult) {
      handleProceedToConfirmRequests();
    } else {
      setStep('configure');
    }
    setAlgorithmResult(null);
  }, [algorithmResult, handleProceedToConfirmRequests]);

  const handleFinalize = useCallback(() => {
    if (onComplete && algorithmResult) {
      onComplete(finalPlayers, finalTeams);
    }
  }, [onComplete, algorithmResult, finalPlayers, finalTeams]);

  // Handle player swap (local, no API)
  const handleSwap = useCallback((
    team1Id: string,
    team2Id: string,
    player1Id: string,
    player2Id: string,
    _reason: string
  ) => {
    // Find the players
    const player1 = finalPlayers.find(p => p.id === player1Id);
    const player2 = finalPlayers.find(p => p.id === player2Id);

    if (!player1 || !player2) return;

    // Update player assignments
    const updatedPlayers = finalPlayers.map(p => {
      if (p.id === player1Id) {
        return { ...p, draftedByTeamId: team2Id };
      }
      if (p.id === player2Id) {
        return { ...p, draftedByTeamId: team1Id };
      }
      return p;
    });

    // Update team rosters
    const updatedTeams = finalTeams.map(team => {
      if (team.id === team1Id) {
        // Remove player1, add player2
        const newRoster = team.roster.filter(p => p.id !== player1Id);
        newRoster.push({ ...player2, draftedByTeamId: team1Id });
        const newTotalScore = newRoster.reduce((sum, p) => sum + p.totalScore, 0);
        return { ...team, roster: newRoster, totalScore: newTotalScore };
      }
      if (team.id === team2Id) {
        // Remove player2, add player1
        const newRoster = team.roster.filter(p => p.id !== player2Id);
        newRoster.push({ ...player1, draftedByTeamId: team2Id });
        const newTotalScore = newRoster.reduce((sum, p) => sum + p.totalScore, 0);
        return { ...team, roster: newRoster, totalScore: newTotalScore };
      }
      return team;
    });

    setFinalPlayers(updatedPlayers);
    setFinalTeams(updatedTeams);
    setShowSwapModal(false);
  }, [finalPlayers, finalTeams]);

  // -----------------------------------------------------------------------------
  // Render
  // -----------------------------------------------------------------------------

  const steps: { key: TeamBuilderStep; label: string; icon: typeof Upload }[] = [
    { key: 'setup', label: 'Setup', icon: Settings },
    { key: 'import', label: 'Import', icon: Upload },
    { key: 'resolution', label: 'Resolution', icon: Users },
    { key: 'confirm-requests', label: 'Confirm', icon: ClipboardCheck },
    { key: 'configure', label: 'Configure', icon: Wand2 },
    { key: 'generate', label: 'Generate', icon: Play },
    { key: 'results', label: 'Results', icon: BarChart3 },
  ];

  const currentStepIndex = steps.findIndex(s => s.key === step);

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900">
      {/* Header */}
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <button
            onClick={onBack}
            className="flex items-center gap-2 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to Divisions
          </button>

          <div className="flex items-center gap-2">
            <div className="px-3 py-1 bg-purple-100 dark:bg-purple-900/30 rounded-full">
              <span className="text-sm font-medium text-purple-700 dark:text-purple-300">
                {division.name}
              </span>
            </div>
          </div>
        </div>
      </div>

      {/* Step indicator */}
      <div className="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-4">
        <div className="max-w-6xl mx-auto">
          <div className="flex items-center justify-center gap-2">
            {steps.map((s, index) => (
              <div key={s.key} className="flex items-center">
                {index > 0 && (
                  <div className={`w-12 h-0.5 mx-2 ${
                    index <= currentStepIndex
                      ? 'bg-purple-500'
                      : 'bg-gray-300 dark:bg-gray-600'
                  }`} />
                )}
                <div
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-full text-sm ${
                    s.key === step
                      ? 'bg-purple-600 text-white'
                      : index < currentStepIndex
                      ? 'bg-purple-100 dark:bg-purple-900/30 text-purple-700 dark:text-purple-300'
                      : 'bg-gray-100 dark:bg-gray-700 text-gray-500 dark:text-gray-400'
                  }`}
                >
                  {index < currentStepIndex ? (
                    <Check className="w-4 h-4" />
                  ) : (
                    <s.icon className="w-4 h-4" />
                  )}
                  <span className="hidden sm:inline">{s.label}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="max-w-6xl mx-auto p-6">
        {/* Step 0: Setup */}
        {step === 'setup' && (
          <div className="space-y-6">
            <div className="text-center mb-8">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
                Division Setup
              </h2>
              <p className="text-gray-600 dark:text-gray-400">
                Review and configure teams and coaches before importing players.
              </p>
            </div>

            <div className="max-w-2xl mx-auto space-y-6">
              {/* Division Info */}
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                  Division Settings
                </h3>
                <div className="grid grid-cols-2 gap-4 text-sm">
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Name:</span>
                    <span className="ml-2 font-medium text-gray-900 dark:text-white">{division.name}</span>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Age Range:</span>
                    <span className="ml-2 font-medium text-gray-900 dark:text-white">
                      {division.ageRange.min}-{division.ageRange.max}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Teams:</span>
                    <span className="ml-2 font-medium text-gray-900 dark:text-white">{teams.length}</span>
                  </div>
                  <div>
                    <span className="text-gray-500 dark:text-gray-400">Mode:</span>
                    <span className="ml-2 font-medium text-purple-600 dark:text-purple-400">
                      League Generated
                    </span>
                  </div>
                </div>
              </div>

              {/* Team Coaches */}
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                  Team Coaches
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  Configure head coach and assistant coach for each team. These names are used for coach kid detection.
                </p>
                <div className="space-y-3">
                  {teams.map((team, index) => (
                    <div key={team.id} className="flex items-center gap-3">
                      <span className="text-sm font-medium text-gray-500 dark:text-gray-400 w-20">
                        Team {index + 1}
                      </span>
                      <input
                        type="text"
                        value={team.headCoach || ''}
                        onChange={(e) => handleUpdateTeam(team.id, { headCoach: e.target.value })}
                        placeholder="Last name only (e.g., Smith)"
                        className="flex-1 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                      />
                      <input
                        type="text"
                        value={team.assistantCoach || ''}
                        onChange={(e) => handleUpdateTeam(team.id, { assistantCoach: e.target.value })}
                        placeholder="Last name only"
                        className="flex-1 px-3 py-2 text-sm border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 focus:ring-2 focus:ring-purple-500 focus:border-transparent"
                      />
                    </div>
                  ))}
                </div>
              </div>

              {/* Continue button */}
              <div className="flex justify-end">
                <button
                  onClick={() => {
                    // Save coach names to division before proceeding (mark as local update)
                    if (onUpdateTeams) {
                      isLocalUpdate.current = true;
                      onUpdateTeams(teams);
                    }
                    setStep('import');
                  }}
                  className="px-6 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-medium flex items-center gap-2"
                >
                  Continue to Import
                  <Upload className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Step 1: Import */}
        {step === 'import' && (
          <div className="space-y-6">
            <div className="text-center mb-8">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
                Import Player Data
              </h2>
              <p className="text-gray-600 dark:text-gray-400">
                First, import evaluation data (skills), then registration data (requests).
              </p>
            </div>

            {evalPlayers.length === 0 ? (
              <EvaluationImport
                teamCount={division.teamCount}
                initialTeamNames={teams.map(t => t.headCoach || '')}
                initialAssistantCoaches={teams.map(t => t.assistantCoach || '')}
                onComplete={handleEvalImportComplete}
                onCancel={onBack}
              />
            ) : (
              <div className="space-y-6">
                {/* Eval data loaded */}
                <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
                  <div className="flex items-center gap-3">
                    <Check className="w-5 h-5 text-green-600 dark:text-green-400" />
                    <div>
                      <h3 className="font-semibold text-green-800 dark:text-green-200">
                        Evaluation Data Loaded
                      </h3>
                      <p className="text-sm text-green-700 dark:text-green-300">
                        {evalPlayers.length} players with skill scores
                      </p>
                    </div>
                  </div>
                </div>

                {/* Registration data upload */}
                <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                    Upload Registration Data (Optional)
                  </h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mb-4">
                    Upload an Excel file with a "Registration Data" tab containing friend requests,
                    coach preferences, and school information.
                  </p>

                  {registrationData ? (
                    <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
                      <div className="flex items-center gap-3">
                        <Check className="w-5 h-5 text-green-600 dark:text-green-400" />
                        <div>
                          <h4 className="font-semibold text-green-800 dark:text-green-200">
                            Registration Data Loaded
                          </h4>
                          <p className="text-sm text-green-700 dark:text-green-300">
                            {registrationData.rows.length} players with request data
                          </p>
                          {unmatchedPlayers.length > 0 && (
                            <p className="text-sm text-amber-600 dark:text-amber-400 mt-1">
                              {unmatchedPlayers.length} players need name resolution
                            </p>
                          )}
                        </div>
                      </div>
                    </div>
                  ) : (
                    <div className="border-2 border-dashed border-gray-300 dark:border-gray-600 rounded-lg p-8 text-center">
                      <input
                        type="file"
                        accept=".xlsx,.xls"
                        onChange={(e) => {
                          const file = e.target.files?.[0];
                          if (file) handleRegistrationFileUpload(file);
                        }}
                        className="hidden"
                        id="registration-upload"
                      />
                      <label
                        htmlFor="registration-upload"
                        className="cursor-pointer"
                      >
                        <Upload className="w-12 h-12 text-gray-400 mx-auto mb-4" />
                        <p className="text-gray-600 dark:text-gray-400">
                          Click to upload or drag and drop
                        </p>
                        <p className="text-sm text-gray-500 dark:text-gray-500 mt-1">
                          Excel file with Registration Data tab
                        </p>
                      </label>
                    </div>
                  )}
                </div>

                {/* Continue button */}
                <div className="flex justify-end">
                  <button
                    onClick={() => setStep('resolution')}
                    className="px-6 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-medium"
                  >
                    Continue to Resolution
                  </button>
                </div>
              </div>
            )}
          </div>
        )}

        {/* Step 2: Resolution */}
        {step === 'resolution' && (
          <div className="space-y-6">
            <div className="text-center mb-8">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
                Resolve Player Data
              </h2>
              <p className="text-gray-600 dark:text-gray-400">
                Match registration names to evaluation data and resolve teammate requests.
              </p>
            </div>

            {/* Data Comparison Summary */}
            {registrationData && (
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                  Data Comparison
                </h3>
                <div className="grid grid-cols-3 gap-4">
                  {/* Registration Data */}
                  <div className="text-center p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                    <div className="text-3xl font-bold text-blue-600 dark:text-blue-400">
                      {registrationPlayers.length}
                    </div>
                    <div className="text-sm text-blue-700 dark:text-blue-300 font-medium">
                      Registration
                    </div>
                    <div className="text-xs text-blue-600 dark:text-blue-400 mt-1">
                      (from Registration Data tab)
                    </div>
                  </div>

                  {/* Eval Data */}
                  <div className="text-center p-4 bg-green-50 dark:bg-green-900/20 rounded-lg">
                    <div className="text-3xl font-bold text-green-600 dark:text-green-400">
                      {evalPlayers.length}
                    </div>
                    <div className="text-sm text-green-700 dark:text-green-300 font-medium">
                      Evaluated
                    </div>
                    <div className="text-xs text-green-600 dark:text-green-400 mt-1">
                      (from Summary/Eval tabs)
                    </div>
                  </div>

                  {/* Matched */}
                  <div className="text-center p-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
                    <div className="text-3xl font-bold text-purple-600 dark:text-purple-400">
                      {registrationPlayers.filter(p => p.evalBib).length}
                    </div>
                    <div className="text-sm text-purple-700 dark:text-purple-300 font-medium">
                      Linked
                    </div>
                    <div className="text-xs text-purple-600 dark:text-purple-400 mt-1">
                      {(() => {
                        const exact = registrationPlayers.filter(p => p.match.matchType === 'exact').length;
                        const fuzzy = registrationPlayers.filter(p => p.match.matchType === 'fuzzy').length;
                        if (fuzzy > 0) {
                          return `(${exact} exact, ${fuzzy} fuzzy)`;
                        }
                        return '(auto-linked by name)';
                      })()}
                    </div>
                  </div>
                </div>

                {/* Delta Details - compute unmatched from both sides */}
                {(() => {
                  // Registration players without eval matches
                  const unmatchedReg = registrationPlayers.filter(p => !p.evalBib);
                  // Eval players without registration matches
                  const matchedBibs = new Set(registrationPlayers.filter(p => p.evalBib).map(p => p.evalBib));
                  const unmatchedEval = evalPlayers.filter(p => !matchedBibs.has(p.bib));

                  // Show delta section if there are any unmatched players
                  if (unmatchedReg.length === 0 && unmatchedEval.length === 0) return null;

                  return (
                    <div className="mt-4 pt-4 border-t border-gray-200 dark:border-gray-700">
                      <div className="grid grid-cols-2 gap-4">
                        {/* In Registration but not Eval (DNE candidates) */}
                        {unmatchedReg.length > 0 && (
                          <div className="p-3 bg-amber-50 dark:bg-amber-900/20 rounded-lg">
                            <div className="text-sm font-medium text-amber-800 dark:text-amber-200 mb-2">
                              In Registration, Not Evaluated ({unmatchedReg.length})
                            </div>
                            <div className="text-xs text-amber-700 dark:text-amber-300 space-y-1 max-h-32 overflow-y-auto">
                              {unmatchedReg.map(p => (
                                <div key={p.registrationIndex}>• {p.fullName}</div>
                              ))}
                            </div>
                            <div className="text-xs text-amber-600 dark:text-amber-400 mt-2 italic">
                              These players can be marked as DNE below
                            </div>
                          </div>
                        )}

                        {/* In Eval but not Registration (orphaned eval records) */}
                        {unmatchedEval.length > 0 && (
                          <div className="p-3 bg-gray-100 dark:bg-gray-700/50 rounded-lg">
                            <div className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-2">
                              Evaluated, Not Registered ({unmatchedEval.length})
                            </div>
                            <div className="text-xs text-gray-600 dark:text-gray-400 space-y-1 max-h-32 overflow-y-auto">
                              {unmatchedEval.map(p => (
                                <div key={p.bib}>• {p.firstName} {p.lastName} (BIB {p.bib})</div>
                              ))}
                            </div>
                            <div className="text-xs text-gray-500 dark:text-gray-500 mt-2 italic">
                              May be name mismatches or withdrawn players
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Name matching */}
            {unmatchedPlayers.length > 0 && (
              <NameMatchResolver
                unmatchedPlayers={unmatchedPlayers.map(p => ({
                  registrationIndex: p.registrationIndex,
                  firstName: p.firstName,
                  lastName: p.lastName,
                  fullName: p.fullName,
                  match: p.match,
                }))}
                availableEvalPlayers={evalPlayers.map(p => ({
                  bib: p.bib,
                  firstName: p.firstName,
                  lastName: p.lastName,
                  fullName: `${p.firstName} ${p.lastName}`,
                }))}
                onResolve={handleNameResolve}
                onResolveAll={(resolutions) => {
                  resolutions.forEach((bib, index) => {
                    handleNameResolve(index, bib);
                  });
                }}
                onCreateWithoutEval={(index) => {
                  handleCreateDNEPlayer(index);
                }}
              />
            )}

            {/* Teammate request resolution would go here */}
            {registrationData && unmatchedPlayers.length === 0 && (() => {
              // Check if truly all players are matched
              const unmatchedRegCount = registrationPlayers.filter(p => !p.evalBib).length;
              const matchedBibs = new Set(registrationPlayers.filter(p => p.evalBib).map(p => p.evalBib));
              const unmatchedEvalCount = evalPlayers.filter(p => !matchedBibs.has(p.bib)).length;

              // Only show "all matched" if there are no unmatched on either side
              if (unmatchedRegCount > 0 || unmatchedEvalCount > 0) return null;

              return (
                <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
                  <div className="flex items-center gap-3">
                    <Check className="w-5 h-5 text-green-600 dark:text-green-400" />
                    <span className="text-green-800 dark:text-green-200 font-medium">
                      All players matched successfully
                    </span>
                  </div>
                </div>
              );
            })()}

            {!registrationData && (
              <div className="bg-gray-50 dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-4">
                <p className="text-gray-600 dark:text-gray-400">
                  No registration data uploaded. Friend requests and coach preferences will not be available.
                </p>
              </div>
            )}

            {/* Continue button */}
            <div className="flex justify-between">
              <button
                onClick={() => setStep('import')}
                className="px-6 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg font-medium hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Back
              </button>
              <button
                onClick={handleProceedToConfirmRequests}
                className="px-6 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-medium"
              >
                Continue to Confirm Requests
              </button>
            </div>
          </div>
        )}

        {/* Step 3: Confirm Requests */}
        {step === 'confirm-requests' && (
          <RequestConfirmation
            requests={resolvedRequests}
            players={evalPlayers.map(p => ({
              id: p.id,
              firstName: p.firstName,
              lastName: p.lastName,
              bib: p.bib,
            }))}
            teams={teams}
            onUpdateRequest={handleUpdateRequest}
            onContinue={handleProceedToConfigure}
            onBack={() => setStep('resolution')}
          />
        )}

        {/* Step 4: Configure */}
        {step === 'configure' && (
          <div className="space-y-6">
            <div className="text-center mb-8">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
                Configure Teams
              </h2>
              <p className="text-gray-600 dark:text-gray-400">
                Review team coaches and algorithm settings.
              </p>
            </div>

            {/* Algorithm Mode Selection */}
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                Algorithm Mode
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                Choose how teams should be built. Requests-first prioritizes honoring friend requests over balance.
              </p>
              <div className="grid grid-cols-2 gap-4">
                <div
                  className={`p-4 rounded-lg border-2 cursor-pointer transition-colors ${
                    algorithmMode === 'requests-first'
                      ? 'bg-purple-50 dark:bg-purple-900/20 border-purple-500'
                      : 'bg-gray-50 dark:bg-gray-700/50 border-transparent hover:border-gray-300 dark:hover:border-gray-600'
                  }`}
                  onClick={() => setAlgorithmMode('requests-first')}
                >
                  <div className="flex items-center gap-3 mb-2">
                    <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${
                      algorithmMode === 'requests-first'
                        ? 'bg-purple-600'
                        : 'border-2 border-gray-300 dark:border-gray-600'
                    }`}>
                      {algorithmMode === 'requests-first' && (
                        <div className="w-2 h-2 rounded-full bg-white" />
                      )}
                    </div>
                    <h4 className="font-semibold text-gray-900 dark:text-white">
                      Requests First (Recommended)
                    </h4>
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-400 ml-8">
                    Prioritizes honoring friend requests. Two-way friends are placed together first,
                    then other requests are honored. Balance is improved via suggested trades afterward.
                  </p>
                </div>
                <div
                  className={`p-4 rounded-lg border-2 cursor-pointer transition-colors ${
                    algorithmMode === 'balance-first'
                      ? 'bg-purple-50 dark:bg-purple-900/20 border-purple-500'
                      : 'bg-gray-50 dark:bg-gray-700/50 border-transparent hover:border-gray-300 dark:hover:border-gray-600'
                  }`}
                  onClick={() => setAlgorithmMode('balance-first')}
                >
                  <div className="flex items-center gap-3 mb-2">
                    <div className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 ${
                      algorithmMode === 'balance-first'
                        ? 'bg-purple-600'
                        : 'border-2 border-gray-300 dark:border-gray-600'
                    }`}>
                      {algorithmMode === 'balance-first' && (
                        <div className="w-2 h-2 rounded-full bg-white" />
                      )}
                    </div>
                    <h4 className="font-semibold text-gray-900 dark:text-white">
                      Balance First (Original)
                    </h4>
                  </div>
                  <p className="text-sm text-gray-600 dark:text-gray-400 ml-8">
                    Prioritizes team balance. Spreads top talent first, then honors requests only
                    if they don't impact balance too much. May result in lower request satisfaction.
                  </p>
                </div>
              </div>
            </div>

            {/* Teams */}
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                Teams ({teams.length})
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                Coach requests will match against both head coach and assistant coach names.
              </p>
              <div className="grid grid-cols-2 gap-4">
                {teams.map((team, index) => (
                  <div
                    key={team.id}
                    className="border border-gray-200 dark:border-gray-600 rounded-lg p-4"
                  >
                    <div className="flex items-center gap-3 mb-2">
                      <span className="w-8 h-8 bg-purple-100 dark:bg-purple-900/30 rounded-full flex items-center justify-center text-purple-700 dark:text-purple-300 font-medium">
                        {index + 1}
                      </span>
                      <div className="flex-1 flex gap-2">
                        <input
                          type="text"
                          value={team.headCoach}
                          onChange={(e) => handleUpdateTeam(team.id, { headCoach: e.target.value })}
                          placeholder="Head Coach"
                          className="flex-1 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                        />
                        <input
                          type="text"
                          value={team.assistantCoach || ''}
                          onChange={(e) => handleUpdateTeam(team.id, { assistantCoach: e.target.value })}
                          placeholder="Asst. Coach"
                          className="flex-1 px-3 py-1.5 border border-gray-300 dark:border-gray-600 rounded bg-white dark:bg-gray-700 text-gray-900 dark:text-white text-sm"
                        />
                      </div>
                    </div>
                    {team.coachKids.length > 0 && (
                      <p className="text-xs text-gray-500 dark:text-gray-400 ml-11">
                        {team.coachKids.length} coach kid{team.coachKids.length !== 1 ? 's' : ''} locked
                      </p>
                    )}
                  </div>
                ))}
              </div>
            </div>

            {/* Request Resolution Summary */}
            {normalizationResult && (
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                  Request Resolution Summary
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  You'll review and confirm all matches on the next screen.
                </p>
                <div className="grid grid-cols-3 gap-4 mb-4">
                  {/* Coach Requests */}
                  <div className="p-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
                    <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">
                      {normalizationResult.stats.coachRequestsResolved}/{normalizationResult.stats.playersWithCoachRequest}
                    </div>
                    <div className="text-sm text-purple-700 dark:text-purple-300 font-medium">
                      Coach Requests
                    </div>
                    <div className="text-xs text-purple-600 dark:text-purple-400 mt-1">
                      {normalizationResult.stats.playersWithCoachRequest > 0
                        ? `${Math.round((normalizationResult.stats.coachRequestsResolved / normalizationResult.stats.playersWithCoachRequest) * 100)}% auto-matched`
                        : 'No requests'}
                    </div>
                  </div>

                  {/* Teammate Requests */}
                  <div className="p-4 bg-blue-50 dark:bg-blue-900/20 rounded-lg">
                    <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                      {normalizationResult.stats.teammateRequestsResolved}/{normalizationResult.stats.totalTeammateRequests}
                    </div>
                    <div className="text-sm text-blue-700 dark:text-blue-300 font-medium">
                      Buddy Requests
                    </div>
                    <div className="text-xs text-blue-600 dark:text-blue-400 mt-1">
                      {normalizationResult.stats.totalTeammateRequests > 0
                        ? `${Math.round((normalizationResult.stats.teammateRequestsResolved / normalizationResult.stats.totalTeammateRequests) * 100)}% auto-matched`
                        : 'No requests'}
                    </div>
                  </div>

                  {/* Two-Way Requests */}
                  <div className="p-4 bg-green-50 dark:bg-green-900/20 rounded-lg">
                    <div className="text-2xl font-bold text-green-600 dark:text-green-400">
                      {normalizationResult.stats.twoWayRequestsFound}
                    </div>
                    <div className="text-sm text-green-700 dark:text-green-300 font-medium">
                      Two-Way Matches
                    </div>
                    <div className="text-xs text-green-600 dark:text-green-400 mt-1">
                      Both kids requested each other
                    </div>
                  </div>
                </div>

                {/* Schools */}
                {normalizationResult.stats.uniqueSchools > 0 && (
                  <div className="pt-4 border-t border-gray-200 dark:border-gray-700">
                    <div className="text-sm text-gray-600 dark:text-gray-400">
                      <span className="font-medium">{normalizationResult.stats.uniqueSchools} schools</span> detected for clustering
                    </div>
                  </div>
                )}
              </div>
            )}

            {/* Player Request Lookup */}
            {normalizationResult && (
              <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                  Player Request Lookup
                </h3>
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">
                  Search for a player to see their request details and resolution status.
                </p>

                {/* Search input */}
                <div className="relative mb-4">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
                  <input
                    type="text"
                    value={playerSearchQuery}
                    onChange={(e) => setPlayerSearchQuery(e.target.value)}
                    placeholder="Type player name..."
                    className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400"
                  />
                </div>

                {/* Search results */}
                {playerSearchQuery.trim().length >= 2 && (() => {
                  const query = playerSearchQuery.toLowerCase().trim();
                  const matchingPlayers = normalizationResult.players.filter(p =>
                    p.firstName.toLowerCase().includes(query) ||
                    p.lastName.toLowerCase().includes(query) ||
                    `${p.firstName} ${p.lastName}`.toLowerCase().includes(query)
                  ).slice(0, 5);

                  if (matchingPlayers.length === 0) {
                    return (
                      <div className="text-sm text-gray-500 dark:text-gray-400 italic">
                        No players found matching "{playerSearchQuery}"
                      </div>
                    );
                  }

                  return (
                    <div className="space-y-3">
                      {matchingPlayers.map(player => (
                        <div key={player.id} className="p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg border border-gray-200 dark:border-gray-600">
                          <div className="font-medium text-gray-900 dark:text-white mb-3">
                            {player.firstName} {player.lastName}
                            <span className="ml-2 text-xs text-gray-500 dark:text-gray-400">
                              (BIB: {player.bib})
                            </span>
                          </div>

                          {/* Coach Request */}
                          <div className="mb-3">
                            <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase mb-1">
                              Coach Request
                            </div>
                            {player.rawCoachRequest ? (
                              <div className="text-sm">
                                <span className="text-gray-700 dark:text-gray-300">
                                  Requested: "{player.rawCoachRequest}"
                                </span>
                                {player.resolvedCoachTeamId ? (
                                  <span className="ml-2 text-green-600 dark:text-green-400">
                                    → {player.resolvedCoachName} ({player.coachMatchType}, score: {player.coachMatchScore.toFixed(2)})
                                  </span>
                                ) : (
                                  <span className="ml-2 text-red-600 dark:text-red-400">
                                    → Not resolved ({player.coachRequestStatus})
                                  </span>
                                )}
                              </div>
                            ) : (
                              <div className="text-sm text-gray-400 italic">No coach request</div>
                            )}
                          </div>

                          {/* Teammate Requests */}
                          <div>
                            <div className="text-xs font-medium text-gray-500 dark:text-gray-400 uppercase mb-1">
                              Teammate Requests
                            </div>
                            {player.teammateResolutions.length > 0 ? (
                              <div className="space-y-1">
                                {player.teammateResolutions.map((res, idx) => (
                                  <div key={idx} className="text-sm">
                                    <span className="text-gray-700 dark:text-gray-300">
                                      "{res.rawRequest}"
                                    </span>
                                    {res.resolvedPlayerId ? (
                                      <span className="ml-2 text-green-600 dark:text-green-400">
                                        → {res.resolvedPlayerName} ({res.matchType}, score: {res.matchScore.toFixed(2)})
                                        {res.isTwoWay && <span className="ml-1 text-blue-600 dark:text-blue-400">[TWO-WAY]</span>}
                                      </span>
                                    ) : (
                                      <span className="ml-2 text-red-600 dark:text-red-400">
                                        → Not resolved ({res.requestStatus})
                                        {res.suggestedMatches && res.suggestedMatches.length > 0 && (
                                          <span className="ml-1 text-gray-500">
                                            [Suggestions: {res.suggestedMatches.slice(0, 3).map(s => `${s.name} (${s.score.toFixed(2)})`).join(', ')}]
                                          </span>
                                        )}
                                      </span>
                                    )}
                                  </div>
                                ))}
                              </div>
                            ) : (
                              <div className="text-sm text-gray-400 italic">No teammate requests</div>
                            )}
                          </div>

                          {/* School */}
                          {player.normalizedSchool && (
                            <div className="mt-3 pt-3 border-t border-gray-200 dark:border-gray-600">
                              <div className="text-xs text-gray-500 dark:text-gray-400">
                                School: {player.normalizedSchool}
                              </div>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Algorithm config */}
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-2">
                Algorithm Settings
              </h3>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-6">
                Fine-tune how teams are balanced and requests are honored.
              </p>

              <div className="space-y-6">
                {/* Balance Tolerance */}
                <div className="p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-1">
                        Balance Tolerance
                      </label>
                      <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                        How much team total scores can differ from the average.
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-500">
                        <span className="font-medium">Example:</span> With {teams.length} teams averaging ~{Math.round(evalPlayers.reduce((sum, p) => sum + p.totalScore, 0) / teams.length)} points each,
                        ±{Math.round(config.balanceTolerance * 100)}% means teams can range from {Math.round((evalPlayers.reduce((sum, p) => sum + p.totalScore, 0) / teams.length) * (1 - config.balanceTolerance))} to {Math.round((evalPlayers.reduce((sum, p) => sum + p.totalScore, 0) / teams.length) * (1 + config.balanceTolerance))} points.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setConfig({ ...config, balanceTolerance: Math.max(0.05, config.balanceTolerance - 0.01) })}
                        className="w-8 h-8 flex items-center justify-center rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 font-bold"
                      >
                        −
                      </button>
                      <div className="w-16 h-10 flex items-center justify-center rounded-lg bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 font-semibold text-gray-900 dark:text-white">
                        ±{Math.round(config.balanceTolerance * 100)}%
                      </div>
                      <button
                        onClick={() => setConfig({ ...config, balanceTolerance: Math.min(0.25, config.balanceTolerance + 0.01) })}
                        className="w-8 h-8 flex items-center justify-center rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 font-bold"
                      >
                        +
                      </button>
                    </div>
                  </div>
                </div>

                {/* Top Talent Rounds */}
                <div className="p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-1">
                        Top Talent Rounds
                      </label>
                      <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                        Number of rounds where top players are distributed purely by skill (ignoring friend requests).
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-500">
                        <span className="font-medium">Example:</span> With {config.topTalentRounds} rounds and {teams.length} teams,
                        the top {config.topTalentRounds * teams.length} players will be spread evenly across teams before friend requests are considered.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setConfig({ ...config, topTalentRounds: Math.max(1, config.topTalentRounds - 1) })}
                        className="w-8 h-8 flex items-center justify-center rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 font-bold"
                      >
                        −
                      </button>
                      <div className="w-16 h-10 flex items-center justify-center rounded-lg bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 font-semibold text-gray-900 dark:text-white">
                        {config.topTalentRounds}
                      </div>
                      <button
                        onClick={() => setConfig({ ...config, topTalentRounds: Math.min(5, config.topTalentRounds + 1) })}
                        className="w-8 h-8 flex items-center justify-center rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 font-bold"
                      >
                        +
                      </button>
                    </div>
                  </div>
                </div>

                {/* Max Roster Size */}
                <div className="p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-1">
                        Maximum Roster Size
                      </label>
                      <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                        Hard limit on players per team. Teams won't exceed this even to honor requests.
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-500">
                        <span className="font-medium">Target:</span> With {evalPlayers.length} players and {teams.length} teams,
                        average roster is {Math.round(evalPlayers.length / teams.length)} players.
                        {evalPlayers.length % teams.length !== 0 && ` Some teams will have ${Math.ceil(evalPlayers.length / teams.length)}.`}
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setConfig({ ...config, maxRosterSize: Math.max(config.minRosterSize, config.maxRosterSize - 1) })}
                        className="w-8 h-8 flex items-center justify-center rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 font-bold"
                      >
                        −
                      </button>
                      <div className="w-16 h-10 flex items-center justify-center rounded-lg bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 font-semibold text-gray-900 dark:text-white">
                        {config.maxRosterSize}
                      </div>
                      <button
                        onClick={() => setConfig({ ...config, maxRosterSize: Math.min(Math.max(18, evalPlayers.length, config.maxRosterSize), config.maxRosterSize + 1) })}
                        className="w-8 h-8 flex items-center justify-center rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 font-bold"
                      >
                        +
                      </button>
                    </div>
                  </div>
                </div>

                {/* Min Roster Size */}
                <div className="p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1">
                      <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-1">
                        Minimum Roster Size
                      </label>
                      <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                        All teams will have at least this many players before any team gets extras.
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-500">
                        <span className="font-medium">Note:</span> Setting this higher ensures balanced team sizes but may limit friend request matching.
                      </p>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => setConfig({ ...config, minRosterSize: Math.max(1, config.minRosterSize - 1) })}
                        className="w-8 h-8 flex items-center justify-center rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 font-bold"
                      >
                        −
                      </button>
                      <div className="w-16 h-10 flex items-center justify-center rounded-lg bg-white dark:bg-gray-700 border border-gray-300 dark:border-gray-600 font-semibold text-gray-900 dark:text-white">
                        {config.minRosterSize}
                      </div>
                      <button
                        onClick={() => setConfig({ ...config, minRosterSize: Math.min(config.maxRosterSize, config.minRosterSize + 1) })}
                        className="w-8 h-8 flex items-center justify-center rounded-lg border border-gray-300 dark:border-gray-600 bg-white dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-600 font-bold"
                      >
                        +
                      </button>
                    </div>
                  </div>
                </div>

                {/* Prioritize Balance */}
                <div
                  className={`p-4 rounded-lg border-2 cursor-pointer transition-colors ${
                    config.prioritizeBalance
                      ? 'bg-purple-50 dark:bg-purple-900/20 border-purple-300 dark:border-purple-700'
                      : 'bg-gray-50 dark:bg-gray-700/50 border-transparent hover:border-gray-300 dark:hover:border-gray-600'
                  }`}
                  onClick={() => setConfig({ ...config, prioritizeBalance: !config.prioritizeBalance })}
                >
                  <div className="flex items-start gap-3">
                    <div className={`w-5 h-5 mt-0.5 rounded flex items-center justify-center flex-shrink-0 ${
                      config.prioritizeBalance
                        ? 'bg-purple-600 text-white'
                        : 'border-2 border-gray-300 dark:border-gray-600'
                    }`}>
                      {config.prioritizeBalance && (
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                      )}
                    </div>
                    <div className="flex-1">
                      <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-1 cursor-pointer">
                        Prioritize Balance over Happiness
                      </label>
                      <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                        {config.prioritizeBalance
                          ? "Team balance takes priority. Some friend requests may not be honored if they would create unbalanced teams."
                          : "Friend requests take priority. Teams may be slightly unbalanced to honor more requests."}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-500">
                        <span className="font-medium">Recommended:</span> Enable for competitive divisions, disable for younger recreational divisions.
                      </p>
                    </div>
                  </div>
                </div>

                {/* Force Even Teams */}
                <div
                  className={`p-4 rounded-lg border-2 cursor-pointer transition-colors ${
                    config.forceEvenTeams
                      ? 'bg-purple-50 dark:bg-purple-900/20 border-purple-300 dark:border-purple-700'
                      : 'bg-gray-50 dark:bg-gray-700/50 border-transparent hover:border-gray-300 dark:hover:border-gray-600'
                  }`}
                  onClick={() => setConfig({ ...config, forceEvenTeams: !config.forceEvenTeams })}
                >
                  <div className="flex items-start gap-3">
                    <div className={`w-5 h-5 mt-0.5 rounded flex items-center justify-center flex-shrink-0 ${
                      config.forceEvenTeams
                        ? 'bg-purple-600 text-white'
                        : 'border-2 border-gray-300 dark:border-gray-600'
                    }`}>
                      {config.forceEvenTeams && (
                        <svg className="w-3 h-3" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z" clipRule="evenodd" />
                        </svg>
                      )}
                    </div>
                    <div className="flex-1">
                      <label className="block text-sm font-semibold text-gray-900 dark:text-white mb-1 cursor-pointer">
                        Force Even Teams
                      </label>
                      <p className="text-sm text-gray-600 dark:text-gray-400 mb-2">
                        {config.forceEvenTeams
                          ? "All teams will have the same number of players (or differ by at most 1 player)."
                          : "Teams may have uneven sizes to better honor friend requests or balance skill levels."}
                      </p>
                      <p className="text-xs text-gray-500 dark:text-gray-500">
                        <span className="font-medium">With {evalPlayers.length} players and {teams.length} teams:</span>{' '}
                        {evalPlayers.length % teams.length === 0
                          ? `Each team will have exactly ${evalPlayers.length / teams.length} players.`
                          : `${teams.length - (evalPlayers.length % teams.length)} teams will have ${Math.floor(evalPlayers.length / teams.length)} players, ${evalPlayers.length % teams.length} teams will have ${Math.ceil(evalPlayers.length / teams.length)} players.`}
                      </p>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Continue button */}
            <div className="flex justify-between">
              <button
                onClick={() => setStep('confirm-requests')}
                className="px-6 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg font-medium hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Back
              </button>
              <button
                onClick={handleProceedToGenerate}
                className="px-6 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-medium"
              >
                Continue to Generate
              </button>
            </div>
          </div>
        )}

        {/* Step 5: Generate */}
        {step === 'generate' && (
          <div className="space-y-6">
            <div className="text-center mb-8">
              <h2 className="text-2xl font-bold text-gray-900 dark:text-white mb-2">
                Generate Teams
              </h2>
              <p className="text-gray-600 dark:text-gray-400">
                Run the auto-assignment algorithm to create balanced teams.
              </p>
            </div>

            {/* Summary before running */}
            <div className="bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 rounded-lg p-6">
              <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-4">
                Ready to Generate
              </h3>
              <div className="grid grid-cols-3 gap-4 mb-6">
                <div className="text-center p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
                  <div className="text-2xl font-bold text-gray-900 dark:text-white">
                    {evalPlayers.length}
                  </div>
                  <div className="text-sm text-gray-500 dark:text-gray-400">Players</div>
                </div>
                <div className="text-center p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
                  <div className="text-2xl font-bold text-gray-900 dark:text-white">
                    {teams.length}
                  </div>
                  <div className="text-sm text-gray-500 dark:text-gray-400">Teams</div>
                </div>
                <div className="text-center p-4 bg-gray-50 dark:bg-gray-700 rounded-lg">
                  <div className="text-2xl font-bold text-gray-900 dark:text-white">
                    {registrationPlayers.filter(p => p.teammateRequests.length > 0).length}
                  </div>
                  <div className="text-sm text-gray-500 dark:text-gray-400">With Requests</div>
                </div>
              </div>

              <button
                onClick={handleRunAlgorithm}
                className="w-full py-3 bg-purple-600 hover:bg-purple-700 text-white rounded-lg font-semibold flex items-center justify-center gap-2"
              >
                <Play className="w-5 h-5" />
                Run Auto-Assignment
              </button>
            </div>

            {/* Back button */}
            <div className="flex justify-start">
              <button
                onClick={() => setStep('configure')}
                className="px-6 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg font-medium hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                Back to Configure
              </button>
            </div>
          </div>
        )}

        {/* Step 6: Results */}
        {step === 'results' && !algorithmResult && (
          <div className="space-y-6">
            <div className="rounded-lg border border-blue-200 dark:border-blue-800 bg-blue-50 dark:bg-blue-900/20 p-4">
              <h2 className="text-xl font-semibold text-gray-900 dark:text-white">Saved team rosters</h2>
              <p className="mt-2 text-sm text-gray-600 dark:text-gray-300">
                Your saved assignments are shown below. Re-run auto-assignment to generate a new request satisfaction report.
              </p>
            </div>
            <TeamRosters teams={finalTeams.map(team => ({
              ...team, totalScore: team.roster.reduce((sum, player) => sum + player.totalScore, 0),
            }))} currentTeamId={null} />
            <button
              onClick={handleRerun}
              className="px-6 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg font-medium hover:bg-gray-50 dark:hover:bg-gray-700"
            >
              Adjust &amp; Re-run
            </button>
          </div>
        )}
        {step === 'results' && algorithmResult && (
          <div className="space-y-6">
            <TeamBuilderResults
              result={algorithmResult}
              players={finalPlayers}
              onRerun={handleRerun}
            />

            {/* Trade Suggestions (only for requests-first algorithm) */}
            {requestsFirstResult && requestsFirstResult.suggestedTrades.length > 0 && (
              <TradeSuggestions
                suggestedTrades={requestsFirstResult.suggestedTrades}
                players={finalPlayers}
                onApplyTrade={handleApplyTrade}
                onApplyAll={handleApplyAllTrades}
                onDismissTrade={handleDismissTrade}
                appliedTradeIds={appliedTradeIds}
                dismissedTradeIds={dismissedTradeIds}
              />
            )}

            {/* Action buttons */}
            <div className="flex justify-between pt-6 border-t border-gray-200 dark:border-gray-700">
              <div className="flex gap-3">
                <button
                  onClick={handleRerun}
                  className="px-6 py-2 border border-gray-300 dark:border-gray-600 text-gray-700 dark:text-gray-300 rounded-lg font-medium hover:bg-gray-50 dark:hover:bg-gray-700"
                >
                  Adjust & Re-run
                </button>
                <button
                  onClick={() => setShowSwapModal(true)}
                  className="px-6 py-2 border border-blue-500 text-blue-600 dark:text-blue-400 rounded-lg font-medium hover:bg-blue-50 dark:hover:bg-blue-900/20 flex items-center gap-2"
                >
                  <ArrowLeftRight className="w-4 h-4" />
                  Swap Players
                </button>
              </div>
              <button
                onClick={handleFinalize}
                className="px-6 py-2 bg-green-600 hover:bg-green-700 text-white rounded-lg font-semibold flex items-center gap-2"
              >
                <Check className="w-5 h-5" />
                Finalize Teams
              </button>
            </div>

            {/* Swap Modal */}
            {showSwapModal && (
              <TradeModal
                teams={finalTeams}
                players={finalPlayers}
                onExecuteTrade={handleSwap}
                onClose={() => setShowSwapModal(false)}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
};
