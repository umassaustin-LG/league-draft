import { Player, Team, DraftFormat } from '../types';
import { calculateDraftOrder } from './draftOrder';
import { getMandatoryPick, lockSiblingToTeam, getBestAvailable } from './draftLogic';

export interface SimulationOptions {
  includeCoachKids: boolean;
  includeSiblings: boolean;
}

export interface SimulationResult {
  teams: Team[];
  players: Player[];
  timestamp: Date;
  options: SimulationOptions;
}

/**
 * Run a draft simulation without affecting real data.
 * Uses the SAME logic as the real draft (getMandatoryPick, calculateDraftOrder).
 */
export function runSimulation(
  players: Player[],
  teams: Team[],
  draftOrder: string[],
  draftFormat: DraftFormat,
  options: SimulationOptions
): SimulationResult {
  // Deep clone to avoid mutating real state
  const simPlayers: Player[] = structuredClone(players);
  const simTeams: Team[] = structuredClone(teams);

  // Reset all draft state on cloned data
  simPlayers.forEach(p => {
    p.isDrafted = false;
    p.draftedByTeamId = undefined;
    p.draftedInRound = undefined;
    p.draftedAtPick = undefined;
    // Note: Don't reset lockedToTeamId - it may have been set for siblings of coach's kids
  });

  simTeams.forEach(t => {
    t.roster = [];
    t.totalScore = 0;
    t.ageBreakdown = {};
  });

  const totalRounds = Math.ceil(simPlayers.length / simTeams.length);
  let overallPick = 0;

  // Track picks made by each team
  const teamPicksMade: Record<string, number> = {};
  simTeams.forEach(t => { teamPicksMade[t.id] = 0; });

  for (let round = 1; round <= totalRounds; round++) {
    // USE THE SAME calculateDraftOrder function as real draft
    const roundOrder = calculateDraftOrder(simTeams, round, draftFormat, draftOrder);

    for (const teamId of roundOrder) {
      const team = simTeams.find(t => t.id === teamId);
      if (!team) continue;

      // Check if all players are drafted
      const availablePlayers = simPlayers.filter(p => !p.isDrafted);
      if (availablePlayers.length === 0) break;

      let playerToDraft: Player | null = null;

      // USE THE SAME getMandatoryPick function as real draft
      // Pass totalRounds and teamPicksMade to enable "not enough picks" logic
      const mandatoryResult = getMandatoryPick(simPlayers, teamId, round, {
        ...options,
        totalRounds,
        teamPicksMade: teamPicksMade[teamId],
      });

      if (mandatoryResult) {
        playerToDraft = mandatoryResult.player;
      } else {
        // USE THE SAME getBestAvailable function - pass teamId and options to respect checkbox settings
        playerToDraft = getBestAvailable(simPlayers, teamId, options);
      }

      if (playerToDraft) {
        overallPick++;
        teamPicksMade[teamId]++;

        // Execute simulated draft
        playerToDraft.isDrafted = true;
        playerToDraft.draftedByTeamId = team.id;
        playerToDraft.draftedInRound = round;
        playerToDraft.draftedAtPick = overallPick;

        // Update team roster and score
        team.roster.push(playerToDraft);
        team.totalScore += playerToDraft.totalScore;

        // Update age breakdown
        const age = playerToDraft.littleLeagueAge;
        team.ageBreakdown[age] = (team.ageBreakdown[age] || 0) + 1;

        // Lock siblings to this team (same as real draft)
        if (options.includeSiblings) {
          lockSiblingToTeam(simPlayers, playerToDraft, team.id);
        }
      }
    }
  }

  return {
    teams: simTeams,
    players: simPlayers,
    timestamp: new Date(),
    options,
  };
}

/**
 * Calculate simulation statistics
 * Only includes players from complete rounds to ensure fair comparison
 * (avoids skewing when some teams get an extra player in incomplete final round)
 */
export function getSimulationStats(result: SimulationResult) {
  const teamCount = result.teams.length;
  const totalPlayers = result.players.filter(p => p.isDrafted).length;
  const completeRounds = Math.floor(totalPlayers / teamCount);

  // Calculate scores using only players from complete rounds (all players)
  const teamScores = result.teams.map(team => {
    const completeRoundPlayers = team.roster.filter(
      p => p.draftedInRound !== undefined && p.draftedInRound <= completeRounds
    );
    return completeRoundPlayers.reduce((sum, p) => sum + p.totalScore, 0);
  });

  // Calculate scores using only top 8 picks per team (primary comparison metric)
  // This avoids skewing from 0-score players and late-round unknowns
  const TOP_PICKS_COUNT = 8;
  const teamTop8Scores = result.teams.map(team => {
    // Get players sorted by draft pick order (earliest first)
    const sortedRoster = [...team.roster].sort((a, b) => {
      const pickA = a.draftedAtPick ?? Infinity;
      const pickB = b.draftedAtPick ?? Infinity;
      return pickA - pickB;
    });
    // Take top N picks
    const topPicks = sortedRoster.slice(0, TOP_PICKS_COUNT);
    return topPicks.reduce((sum, p) => sum + p.totalScore, 0);
  });

  const highest = Math.max(...teamScores);
  const lowest = Math.min(...teamScores);
  const spread = highest - lowest;
  const average = teamScores.reduce((a, b) => a + b, 0) / teamScores.length;

  const top8Highest = Math.max(...teamTop8Scores);
  const top8Lowest = Math.min(...teamTop8Scores);
  const top8Spread = top8Highest - top8Lowest;
  const top8Average = teamTop8Scores.reduce((a, b) => a + b, 0) / teamTop8Scores.length;

  return {
    // All players stats
    highest,
    lowest,
    spread,
    average,
    // Top 8 picks stats (primary comparison metric)
    top8Highest,
    top8Lowest,
    top8Spread,
    top8Average,
  };
}
