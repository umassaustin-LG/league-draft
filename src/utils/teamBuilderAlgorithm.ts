/**
 * Team Builder Auto-Assignment Algorithm
 *
 * Implements a greedy assignment algorithm that:
 * 1. Places locked players first (coach kids, siblings)
 * 2. Spreads top talent evenly across teams
 * 3. Honors friend requests (two-way > one-way)
 * 4. Honors coach requests
 * 5. Clusters by school when no other signal
 * 6. Falls back to team balance
 *
 * Outputs assignments in draft-compatible format (simulated picks).
 */

import {
  Player,
  Team,
  DraftPick,
  ResolvedRequest,
  RequestCluster,
  RequestsFirstConfig,
  DEFAULT_REQUESTS_FIRST_CONFIG,
  TradeCandidate,
} from '../types';
import { buildRequestClusters, splitOversizedCluster } from './teamBuilderParser';
import { getTeamDisplayName } from './teamUtils';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface TeamBuilderConfig {
  balanceTolerance: number; // e.g., 0.10 for ±10%
  topTalentRounds: number; // Number of "rounds" of top talent to spread (e.g., 2)
  maxRosterSize: number; // Hard max per team (e.g., 13)
  minRosterSize: number; // Minimum players per team (e.g., 10)
  prioritizeBalance: boolean; // If true, balance > happiness; if false, happiness > balance
  forceEvenTeams: boolean; // If true, all teams will have same size (or differ by at most 1)
}

export const DEFAULT_TEAM_BUILDER_CONFIG: TeamBuilderConfig = {
  balanceTolerance: 0.10,
  topTalentRounds: 2,
  maxRosterSize: 13,
  minRosterSize: 10,
  prioritizeBalance: true,
  forceEvenTeams: false,
};

export interface TeamBuilderPlayer extends Player {
  // Resolved request data (from Phase 2 resolution)
  resolvedCoachTeamId?: string | null;
  resolvedTeammateIds?: string[]; // Player IDs of resolved teammate requests
  twoWayTeammateIds?: string[]; // Subset that are two-way
  oneWayTeammateIds?: string[]; // Subset that are one-way
}

export interface TeamBuilderTeam extends Team {
  // Track assignments during algorithm
  assignedPlayerIds: string[];
  currentScore: number;
}

export type HappinessScore = 'all' | 'some' | 'none' | 'no-requests';

export interface AssignmentResult {
  playerId: string;
  teamId: string;
  round: number;
  pick: number;
  reason: AssignmentReason;
}

export type AssignmentReason =
  | 'coach-kid'
  | 'assistant-coach-kid'
  | 'sibling-lock'
  | 'manual-lock'
  | 'top-talent'
  | 'two-way-friend'
  | 'one-way-friend'
  | 'coach-request'
  | 'school-cluster'
  | 'balance';

export interface PlayerHappiness {
  playerId: string;
  score: HappinessScore;
  coachRequestHonored: boolean | null; // null if no request
  teammateRequestsHonored: number;
  teammateRequestsTotal: number;
  twoWayRequestsHonored: number;
  twoWayRequestsTotal: number;
}

export interface TeamBuilderResult {
  assignments: AssignmentResult[];
  teamSummaries: TeamSummary[];
  playerHappiness: PlayerHappiness[];
  warnings: string[];
  stats: {
    totalPlayers: number;
    lockedPlayers: number;
    topTalentPlayers: number;
    requestBasedPlayers: number;
    balanceBasedPlayers: number;
    twoWayRequestsHonored: number;
    twoWayRequestsTotal: number;
    oneWayRequestsHonored: number;
    oneWayRequestsTotal: number;
    coachRequestsHonored: number;
    coachRequestsTotal: number;
    averageHappiness: number; // 0-1
  };
}

export interface TeamSummary {
  teamId: string;
  teamName: string;
  coachName: string;
  rosterCount: number;
  totalScore: number;
  averageScore: number; // Average score per player (totalScore / rosterCount)
  meanDelta: number; // Difference from mean average (positive = above, negative = below)
  meanDeltaPercent: number; // As percentage of mean average
}

export function fillMinimumRosters(
  players: TeamBuilderPlayer[],
  teams: TeamBuilderTeam[],
  assignments: AssignmentResult[],
  config: Pick<TeamBuilderConfig, 'minRosterSize' | 'maxRosterSize' | 'forceEvenTeams'>,
  warnings: string[],
  requests: ResolvedRequest[] = []
) {
  if (teams.length === 0) return;
  const minimum = Math.min(
    config.maxRosterSize,
    Math.max(1, config.minRosterSize),
    Math.max(1, Math.floor(assignments.length / teams.length))
  );
  const maximum = config.forceEvenTeams
    ? Math.min(config.maxRosterSize, Math.ceil(players.length / teams.length))
    : config.maxRosterSize;
  const groups: TeamBuilderPlayer[][] = [];
  const assignedTeams = new Map(assignments.map(assignment => [assignment.playerId, assignment.teamId]));
  const preferences = new Map<string, { playerId: string; targetId: string; type: 'coach' | 'teammate' }>();
  const addPreference = (playerId: string, targetId: string, type: 'coach' | 'teammate') => {
    preferences.set(`${playerId}:${type}:${targetId}`, { playerId, targetId, type });
  };
  for (const request of requests) {
    if (request.resolvedTargetId && ['auto-confirmed', 'user-confirmed'].includes(request.status)) {
      addPreference(request.playerId, request.resolvedTargetId, request.requestType);
    }
  }
  const visited = new Set<string>();
  for (const player of players) {
    if (visited.has(player.id)) continue;
    const group = [player];
    visited.add(player.id);
    for (let i = 0; i < group.length; i++) {
      for (const sibling of players) {
        if (!visited.has(sibling.id) && (
          sibling.siblingId === group[i].id || group[i].siblingId === sibling.id
        )) {
          visited.add(sibling.id);
          group.push(sibling);
        }
      }
    }
    groups.push(group);
  }

  for (const recipient of [...teams].sort((a, b) => a.assignedPlayerIds.length - b.assignedPlayerIds.length)) {
    while (recipient.assignedPlayerIds.length < minimum) {
      const deficit = minimum - recipient.assignedPlayerIds.length;
      const requestLoss = (group: TeamBuilderPlayer[]) => {
        const moving = new Set(group.map(player => player.id));
        let lost = 0;
        for (const { playerId, targetId, type } of preferences.values()) {
          const before = assignedTeams.get(playerId);
          const targetBefore = type === 'coach' ? targetId : assignedTeams.get(targetId);
          const after = moving.has(playerId) ? recipient.id : before;
          const targetAfter = type === 'teammate' && moving.has(targetId) ? recipient.id : targetBefore;
          if (before && before === targetBefore && after !== targetAfter) lost++;
        }
        return lost;
      };
      const group = [...groups].sort((a, b) =>
        Number(b.length === deficit) - Number(a.length === deficit) ||
        requestLoss(a) - requestLoss(b) ||
        Math.abs(a.length - deficit) - Math.abs(b.length - deficit)
      ).find(group => {
        if (group.some(player => player.isCoachKid || player.lockedToTeamId)) return false;
        if (recipient.assignedPlayerIds.length + group.length > maximum) return false;
        const donor = teams.find(team => team.assignedPlayerIds.includes(group[0].id));
        return donor && donor !== recipient &&
          donor.assignedPlayerIds.length - group.length >= minimum &&
          group.every(player => donor.assignedPlayerIds.includes(player.id));
      });
      if (!group) break;
      const donor = teams.find(team => team.assignedPlayerIds.includes(group[0].id))!;
      for (const player of group) {
        donor.assignedPlayerIds = donor.assignedPlayerIds.filter(id => id !== player.id);
        donor.currentScore -= player.totalScore;
        recipient.assignedPlayerIds.push(player.id);
        recipient.currentScore += player.totalScore;
        const assignment = assignments.find(assignment => assignment.playerId === player.id)!;
        assignment.teamId = recipient.id;
        assignment.reason = 'balance';
        assignedTeams.set(player.id, recipient.id);
      }
    }
  }
  for (const team of teams) {
    if (team.assignedPlayerIds.length < Math.max(1, config.minRosterSize)) {
      warnings.push(`${getTeamDisplayName(team)} has ${team.assignedPlayerIds.length} players, below the minimum of ${Math.max(1, config.minRosterSize)}. Not enough movable players; review roster limits and locked assignments.`);
    }
  }
}

// -----------------------------------------------------------------------------
// Main Algorithm
// -----------------------------------------------------------------------------

function placeSiblingGroups(
  players: TeamBuilderPlayer[],
  teams: TeamBuilderTeam[],
  unassigned: Set<string>,
  assign: (playerId: string, teamId: string, reason: AssignmentReason) => unknown,
  capacity: (team: TeamBuilderTeam) => number,
  warnings: string[]
): Set<string> {
  const byId = new Map(players.map(player => [player.id, player]));
  const neighbors = new Map(players.map(player => [player.id, new Set<string>()]));
  for (const player of players) {
    if (player.siblingId && byId.has(player.siblingId)) {
      neighbors.get(player.id)!.add(player.siblingId);
      neighbors.get(player.siblingId)!.add(player.id);
    }
  }
  const visited = new Set<string>();
  const blocked = new Set<string>();
  const groups: { members: TeamBuilderPlayer[]; anchors: Set<string> }[] = [];
  for (const player of [...players].sort((a, b) => b.totalScore - a.totalScore)) {
    if (visited.has(player.id)) continue;
    const group: TeamBuilderPlayer[] = [];
    const pending = [player.id];
    visited.add(player.id);
    while (pending.length) {
      const id = pending.pop()!;
      group.push(byId.get(id)!);
      for (const neighbor of neighbors.get(id)!) {
        if (!visited.has(neighbor)) {
          visited.add(neighbor);
          pending.push(neighbor);
        }
      }
    }
    if (group.length < 2) continue;
    const anchors = new Set<string>();
    for (const member of group) {
      const assignedTeam = teams.find(team => team.assignedPlayerIds.includes(member.id));
      if (assignedTeam) anchors.add(assignedTeam.id);
      if (member.isCoachKid && member.coachTeamId) anchors.add(member.coachTeamId);
      if (member.lockedToTeamId) anchors.add(member.lockedToTeamId);
    }
    groups.push({ members: group, anchors });
  }
  groups.sort((a, b) => Number(b.anchors.size > 0) - Number(a.anchors.size > 0)
    || b.members.length - a.members.length
    || Math.max(...b.members.map(member => member.totalScore)) - Math.max(...a.members.map(member => member.totalScore)));
  for (const { members: group, anchors } of groups) {
    const remaining = group.filter(member => unassigned.has(member.id));
    const team = anchors.size > 1 ? undefined : [...teams]
      .filter(team => (!anchors.size || anchors.has(team.id))
        && team.assignedPlayerIds.length + remaining.length <= capacity(team))
      .sort((a, b) => a.currentScore - b.currentScore)[0];
    if (!team) {
      warnings.push(`Sibling group ${group.map(member => member.name).join(', ')} could not be placed together within roster limits and locked assignments. Existing placements are unchanged; remaining siblings are unassigned.`);
      remaining.forEach(member => blocked.add(member.id));
      continue;
    }
    for (const member of remaining) assign(member.id, team.id, 'sibling-lock');
  }
  return blocked;
}

/**
 * Run the team builder auto-assignment algorithm.
 */
export function runTeamBuilderAlgorithm(
  players: TeamBuilderPlayer[],
  teams: Team[],
  config: TeamBuilderConfig = DEFAULT_TEAM_BUILDER_CONFIG,
  resolvedRequests: ResolvedRequest[] = []
): TeamBuilderResult {
  const warnings: string[] = [];
  const assignments: AssignmentResult[] = [];

  // Initialize working copies
  const workingTeams: TeamBuilderTeam[] = teams.map(t => ({
    ...t,
    assignedPlayerIds: [],
    currentScore: 0,
  }));

  const unassignedPlayers = new Set(players.map(p => p.id));
  const playerMap = new Map(players.map(p => [p.id, p]));

  let currentRound = 1;
  let currentPick = 1;

  // Helper to assign a player
  const assignPlayer = (
    playerId: string,
    teamId: string,
    reason: AssignmentReason
  ) => {
    const player = playerMap.get(playerId);
    const team = workingTeams.find(t => t.id === teamId);

    if (!player || !team) {
      warnings.push(`Failed to assign player ${playerId} to team ${teamId}`);
      return;
    }

    team.assignedPlayerIds.push(playerId);
    team.currentScore += player.totalScore;
    unassignedPlayers.delete(playerId);

    assignments.push({
      playerId,
      teamId,
      round: currentRound,
      pick: currentPick,
      reason,
    });

    currentPick++;
    if (currentPick > teams.length) {
      currentRound++;
      currentPick = 1;
    }
  };

  // Calculate target roster size for even teams
  const baseRosterSize = Math.floor(players.length / teams.length);
  const extraPlayers = players.length % teams.length;
  // Some teams get baseRosterSize + 1, others get baseRosterSize
  // The first 'extraPlayers' teams (by current roster count) can have the extra player

  // Helper to check if team can accept more players
  const canAcceptPlayer = (team: TeamBuilderTeam): boolean => {
    if (team.assignedPlayerIds.length >= config.maxRosterSize) {
      return false;
    }

    if (config.forceEvenTeams) {
      // Count how many teams already have baseRosterSize + 1 players
      const teamsWithExtra = workingTeams.filter(t => t.assignedPlayerIds.length > baseRosterSize).length;

      // If this team is at baseRosterSize, it can only accept if there are still extra slots available
      if (team.assignedPlayerIds.length >= baseRosterSize) {
        // Team is at base size - can only go to base+1 if extra slots remain
        if (team.assignedPlayerIds.length === baseRosterSize && teamsWithExtra < extraPlayers) {
          return true;
        }
        return false;
      }
      return true;
    }

    return true;
  };

  // Helper to check if any team is below minimum roster size
  const getTeamsBelowMinimum = (): TeamBuilderTeam[] => {
    return workingTeams.filter(t =>
      t.assignedPlayerIds.length < config.minRosterSize && canAcceptPlayer(t)
    );
  };

  // Helper to get the team with fewest players that's below minimum (for priority filling)
  const getSmallestTeamBelowMinimum = (): TeamBuilderTeam | null => {
    const belowMin = getTeamsBelowMinimum();
    if (belowMin.length === 0) return null;
    return belowMin.reduce((smallest, team) =>
      team.assignedPlayerIds.length < smallest.assignedPlayerIds.length ? team : smallest
    );
  };

  // Helper to get team with lowest score that can accept
  // Prioritizes teams below minimum roster size first
  const getLowestScoreTeam = (): TeamBuilderTeam | null => {
    // First, try to fill teams that are below minimum
    const smallestBelowMin = getSmallestTeamBelowMinimum();
    if (smallestBelowMin) {
      // Among teams below minimum with same roster count, pick lowest score
      const belowMinSameCount = getTeamsBelowMinimum().filter(
        t => t.assignedPlayerIds.length === smallestBelowMin.assignedPlayerIds.length
      );
      return belowMinSameCount.reduce((lowest, team) =>
        team.currentScore < lowest.currentScore ? team : lowest
      );
    }

    // All teams are at or above minimum, use normal logic
    const eligible = workingTeams.filter(canAcceptPlayer);
    if (eligible.length === 0) return null;
    return eligible.reduce((lowest, team) =>
      team.currentScore < lowest.currentScore ? team : lowest
    );
  };

  // Helper to check balance tolerance
  const wouldBreakBalance = (team: TeamBuilderTeam, playerScore: number): boolean => {
    if (!config.prioritizeBalance) return false;

    const totalScoreAfter = workingTeams.reduce((sum, t) =>
      sum + t.currentScore + (t.id === team.id ? playerScore : 0), 0
    );
    const teamCountWithPlayers = workingTeams.filter(t =>
      t.assignedPlayerIds.length > 0 || t.id === team.id
    ).length;

    if (teamCountWithPlayers === 0) return false;

    const meanScore = totalScoreAfter / teamCountWithPlayers;
    const teamScoreAfter = team.currentScore + playerScore;
    const delta = Math.abs(teamScoreAfter - meanScore) / meanScore;

    return delta > config.balanceTolerance;
  };

  // =========================================================================
  // PHASE 0: Place locked players
  // =========================================================================

  // 0a: Coach kids and assistant coach kids
  for (const player of players) {
    if (!unassignedPlayers.has(player.id)) continue;

    if (player.isCoachKid && player.coachTeamId) {
      const team = workingTeams.find(t => t.id === player.coachTeamId);
      if (team && canAcceptPlayer(team)) {
        assignPlayer(player.id, team.id, 'coach-kid');
      }
      // Note: If team not found, player will be assigned in later phases
      // This can happen if coachTeamId doesn't match actual team IDs
    }
  }

  // 0c: Manually locked players (lockedToTeamId)
  for (const player of players) {
    if (!unassignedPlayers.has(player.id)) continue;

    if (player.lockedToTeamId) {
      const team = workingTeams.find(t => t.id === player.lockedToTeamId);
      if (team && canAcceptPlayer(team)) {
        assignPlayer(player.id, team.id, 'manual-lock');
      }
      // Note: If team not found, player will be assigned in later phases
    }
  }

  const blockedSiblingIds = placeSiblingGroups(players, workingTeams, unassignedPlayers, assignPlayer, team => {
    if (!config.forceEvenTeams) return config.maxRosterSize;
    const teamsWithExtra = workingTeams.filter(t => t.assignedPlayerIds.length > baseRosterSize).length;
    const canHaveExtra = team.assignedPlayerIds.length > baseRosterSize || teamsWithExtra < extraPlayers;
    return Math.min(config.maxRosterSize, baseRosterSize + Number(canHaveExtra));
  }, warnings);

  // =========================================================================
  // PHASE 1: Top talent distribution
  // =========================================================================

  const topTalentCount = config.topTalentRounds * teams.length;
  const sortedByScore = [...players]
    .filter(p => unassignedPlayers.has(p.id) && !blockedSiblingIds.has(p.id))
    .sort((a, b) => b.totalScore - a.totalScore);

  const topTalent = sortedByScore.slice(0, topTalentCount);

  for (const player of topTalent) {
    if (!unassignedPlayers.has(player.id)) continue;

    const lowestTeam = getLowestScoreTeam();
    if (lowestTeam) {
      assignPlayer(player.id, lowestTeam.id, 'top-talent');
    } else {
      warnings.push(`No team available for top talent player ${player.name}`);
    }
  }

  // =========================================================================
  // PHASE 2: Request-based placement
  // =========================================================================

  const remainingByScore = [...players]
    .filter(p => unassignedPlayers.has(p.id) && !blockedSiblingIds.has(p.id))
    .sort((a, b) => b.totalScore - a.totalScore);

  for (const player of remainingByScore) {
    if (!unassignedPlayers.has(player.id)) continue;

    // Check if any teams are below minimum - they get priority
    const teamsBelowMin = getTeamsBelowMinimum();
    if (teamsBelowMin.length > 0) {
      // Must fill teams to minimum first - pick the smallest team with lowest score
      const smallestCount = Math.min(...teamsBelowMin.map(t => t.assignedPlayerIds.length));
      const smallestTeams = teamsBelowMin.filter(t => t.assignedPlayerIds.length === smallestCount);
      const targetTeam = smallestTeams.reduce((lowest, team) =>
        team.currentScore < lowest.currentScore ? team : lowest
      );
      assignPlayer(player.id, targetTeam.id, 'balance');
      continue;
    }

    const eligibleTeams = workingTeams.filter(t =>
      canAcceptPlayer(t) && !wouldBreakBalance(t, player.totalScore)
    );

    if (eligibleTeams.length === 0) {
      // Fall back to any team that can accept (ignore balance)
      const anyTeam = workingTeams.filter(canAcceptPlayer);
      if (anyTeam.length > 0) {
        const lowestTeam = anyTeam.reduce((lowest, team) =>
          team.currentScore < lowest.currentScore ? team : lowest
        );
        assignPlayer(player.id, lowestTeam.id, 'balance');
        warnings.push(`Player ${player.name} placed ignoring balance tolerance`);
      } else {
        warnings.push(`No team available for player ${player.name}`);
      }
      continue;
    }

    // Priority 1: Two-way teammate request
    if (player.twoWayTeammateIds && player.twoWayTeammateIds.length > 0) {
      const teamWithTwoWayFriend = eligibleTeams.find(team =>
        player.twoWayTeammateIds!.some(friendId =>
          team.assignedPlayerIds.includes(friendId)
        )
      );
      if (teamWithTwoWayFriend) {
        assignPlayer(player.id, teamWithTwoWayFriend.id, 'two-way-friend');
        continue;
      }
    }

    // Priority 2: One-way teammate request
    if (player.oneWayTeammateIds && player.oneWayTeammateIds.length > 0) {
      const teamWithOneWayFriend = eligibleTeams.find(team =>
        player.oneWayTeammateIds!.some(friendId =>
          team.assignedPlayerIds.includes(friendId)
        )
      );
      if (teamWithOneWayFriend) {
        assignPlayer(player.id, teamWithOneWayFriend.id, 'one-way-friend');
        continue;
      }
    }

    // Priority 3: Coach request
    if (player.resolvedCoachTeamId) {
      const requestedTeam = eligibleTeams.find(t => t.id === player.resolvedCoachTeamId);
      if (requestedTeam) {
        assignPlayer(player.id, requestedTeam.id, 'coach-request');
        continue;
      }
    }

    // Priority 4: School clustering
    if (player.school) {
      const teamSchoolCounts = eligibleTeams.map(team => {
        const schoolmates = team.assignedPlayerIds.filter(pid => {
          const p = playerMap.get(pid);
          return p && p.school && p.school.toLowerCase() === player.school!.toLowerCase();
        }).length;
        return { team, schoolmates };
      });

      const bestSchoolTeam = teamSchoolCounts.reduce((best, current) =>
        current.schoolmates > best.schoolmates ? current : best
      );

      if (bestSchoolTeam.schoolmates > 0) {
        assignPlayer(player.id, bestSchoolTeam.team.id, 'school-cluster');
        continue;
      }
    }

    // Priority 5: Balance fallback (lowest score team)
    const lowestTeam = eligibleTeams.reduce((lowest, team) =>
      team.currentScore < lowest.currentScore ? team : lowest
    );
    assignPlayer(player.id, lowestTeam.id, 'balance');
  }

  // =========================================================================
  // PHASE 3: Remaining players (shouldn't be any, but just in case)
  // =========================================================================

  for (const playerId of unassignedPlayers) {
    if (blockedSiblingIds.has(playerId)) continue;
    const player = playerMap.get(playerId);
    if (!player) continue;

    const lowestTeam = getLowestScoreTeam();
    if (lowestTeam) {
      assignPlayer(playerId, lowestTeam.id, 'balance');
    } else {
      warnings.push(`Could not place player ${player.name} - all teams full`);
    }
  }

  // =========================================================================
  // Calculate results
  // =========================================================================

  fillMinimumRosters(players, workingTeams, assignments, config, warnings, resolvedRequests);

  // Team summaries - use average scores for balance comparison since teams may have different sizes
  const teamAverages = workingTeams.map(team => ({
    team,
    averageScore: team.assignedPlayerIds.length > 0
      ? team.currentScore / team.assignedPlayerIds.length
      : 0,
  }));
  const meanAverageScore = teamAverages.length > 0
    ? teamAverages.reduce((sum, t) => sum + t.averageScore, 0) / teamAverages.length
    : 0;

  const teamSummaries: TeamSummary[] = workingTeams.map(team => {
    const rosterCount = team.assignedPlayerIds.length;
    const averageScore = rosterCount > 0 ? team.currentScore / rosterCount : 0;
    return {
      teamId: team.id,
      teamName: getTeamDisplayName(team),
      coachName: team.headCoach,
      rosterCount,
      totalScore: team.currentScore,
      averageScore,
      meanDelta: averageScore - meanAverageScore,
      meanDeltaPercent: meanAverageScore > 0 ? ((averageScore - meanAverageScore) / meanAverageScore) * 100 : 0,
    };
  });

  // Player happiness
  const playerHappiness: PlayerHappiness[] = players.map(player => {
    const assignment = assignments.find(a => a.playerId === player.id);
    if (!assignment) {
      return {
        playerId: player.id,
        score: 'no-requests' as HappinessScore,
        coachRequestHonored: null,
        teammateRequestsHonored: 0,
        teammateRequestsTotal: 0,
        twoWayRequestsHonored: 0,
        twoWayRequestsTotal: 0,
      };
    }

    const teamId = assignment.teamId;
    const team = workingTeams.find(t => t.id === teamId)!;

    // Coach request
    const hasCoachRequest = !!player.resolvedCoachTeamId;
    const coachRequestHonored = hasCoachRequest ? player.resolvedCoachTeamId === teamId : null;

    // Teammate requests
    const twoWayTotal = player.twoWayTeammateIds?.length || 0;
    const oneWayTotal = player.oneWayTeammateIds?.length || 0;
    const teammateRequestsTotal = twoWayTotal + oneWayTotal;

    const twoWayHonored = player.twoWayTeammateIds?.filter(id =>
      team.assignedPlayerIds.includes(id)
    ).length || 0;

    const oneWayHonored = player.oneWayTeammateIds?.filter(id =>
      team.assignedPlayerIds.includes(id)
    ).length || 0;

    const teammateRequestsHonored = twoWayHonored + oneWayHonored;

    // Calculate happiness score
    let score: HappinessScore;
    const totalRequests = teammateRequestsTotal + (hasCoachRequest ? 1 : 0);
    const totalHonored = teammateRequestsHonored + (coachRequestHonored ? 1 : 0);

    if (totalRequests === 0) {
      score = 'no-requests';
    } else if (totalHonored === totalRequests) {
      score = 'all';
    } else if (totalHonored > 0) {
      score = 'some';
    } else {
      score = 'none';
    }

    return {
      playerId: player.id,
      score,
      coachRequestHonored,
      teammateRequestsHonored,
      teammateRequestsTotal,
      twoWayRequestsHonored: twoWayHonored,
      twoWayRequestsTotal: twoWayTotal,
    };
  });

  // Stats
  const lockedCount = assignments.filter(a =>
    ['coach-kid', 'assistant-coach-kid', 'sibling-lock', 'manual-lock'].includes(a.reason)
  ).length;

  const topTalentAssigned = assignments.filter(a => a.reason === 'top-talent').length;

  const requestBasedCount = assignments.filter(a =>
    ['two-way-friend', 'one-way-friend', 'coach-request', 'school-cluster'].includes(a.reason)
  ).length;

  const balanceBasedCount = assignments.filter(a => a.reason === 'balance').length;

  const twoWayTotal = players.reduce((sum, p) => sum + (p.twoWayTeammateIds?.length || 0), 0);
  const twoWayHonored = playerHappiness.reduce((sum, h) => sum + h.twoWayRequestsHonored, 0);

  const oneWayTotal = players.reduce((sum, p) => sum + (p.oneWayTeammateIds?.length || 0), 0);
  const oneWayHonored = playerHappiness.reduce((sum, h) =>
    sum + (h.teammateRequestsHonored - h.twoWayRequestsHonored), 0
  );

  const coachRequestTotal = players.filter(p => p.resolvedCoachTeamId).length;
  const coachRequestHonored = playerHappiness.filter(h => h.coachRequestHonored === true).length;

  // Average happiness (0-1)
  const happinessScores = playerHappiness.filter(h => h.score !== 'no-requests');
  const avgHappiness = happinessScores.length > 0
    ? happinessScores.reduce((sum, h) => {
        if (h.score === 'all') return sum + 1;
        if (h.score === 'some') return sum + 0.5;
        return sum;
      }, 0) / happinessScores.length
    : 1;

  return {
    assignments,
    teamSummaries,
    playerHappiness,
    warnings,
    stats: {
      totalPlayers: players.length,
      lockedPlayers: lockedCount,
      topTalentPlayers: topTalentAssigned,
      requestBasedPlayers: requestBasedCount,
      balanceBasedPlayers: balanceBasedCount,
      twoWayRequestsHonored: twoWayHonored,
      twoWayRequestsTotal: twoWayTotal,
      oneWayRequestsHonored: oneWayHonored,
      oneWayRequestsTotal: oneWayTotal,
      coachRequestsHonored: coachRequestHonored,
      coachRequestsTotal: coachRequestTotal,
      averageHappiness: avgHappiness,
    },
  };
}

// -----------------------------------------------------------------------------
// Convert to Draft Format
// -----------------------------------------------------------------------------

/**
 * Convert team builder assignments to draft picks format.
 * This allows reuse of existing trade and export modules.
 */
export function convertToDraftPicks(
  assignments: AssignmentResult[]
): DraftPick[] {
  return assignments.map(a => ({
    round: a.round,
    pick: a.pick,
    teamId: a.teamId,
    playerId: a.playerId,
    timestamp: Date.now(),
    wasSkipped: false,
  }));
}

/**
 * Apply assignments to players and teams.
 * Updates isDrafted, draftedByTeamId, etc. on players.
 */
export function applyAssignments(
  players: Player[],
  teams: Team[],
  assignments: AssignmentResult[]
): { players: Player[]; teams: Team[] } {
  const playerMap = new Map(players.map(p => [p.id, { ...p }]));
  const teamMap = new Map(teams.map(t => [t.id, { ...t, roster: [] as Player[] }]));

  for (const assignment of assignments) {
    const player = playerMap.get(assignment.playerId);
    const team = teamMap.get(assignment.teamId);

    if (player && team) {
      player.isDrafted = true;
      player.draftedByTeamId = assignment.teamId;
      player.draftedInRound = assignment.round;
      player.draftedAtPick = assignment.pick;

      team.roster.push(player);
      team.totalScore = team.roster.reduce((sum, p) => sum + p.totalScore, 0);
    }
  }

  // Update age breakdown for each team
  for (const team of teamMap.values()) {
    const ageBreakdown: Record<string, number> = {};
    for (const player of team.roster) {
      const age = String(player.littleLeagueAge);
      ageBreakdown[age] = (ageBreakdown[age] || 0) + 1;
    }
    team.ageBreakdown = ageBreakdown;
  }

  return {
    players: Array.from(playerMap.values()),
    teams: Array.from(teamMap.values()),
  };
}

// -----------------------------------------------------------------------------
// Requests-First Algorithm
// -----------------------------------------------------------------------------

/**
 * Extended result type for requests-first algorithm.
 */
export interface RequestsFirstResult extends TeamBuilderResult {
  clusters: RequestCluster[];
  suggestedTrades: TradeCandidate[];
}

/**
 * Run the requests-first team builder algorithm.
 *
 * This algorithm prioritizes request satisfaction over balance:
 * 1. Place locked players (coach kids, siblings)
 * 2. Build and place two-way request clusters
 * 3. Place remaining players by request weight (two-way > one-way > coach)
 * 4. Suggest trades to improve balance without breaking satisfied requests
 */
export function runRequestsFirstAlgorithm(
  players: TeamBuilderPlayer[],
  teams: Team[],
  resolvedRequests: ResolvedRequest[],
  config: Partial<RequestsFirstConfig> = {}
): RequestsFirstResult {
  const fullConfig = { ...DEFAULT_REQUESTS_FIRST_CONFIG, ...config };
  const warnings: string[] = [];
  const assignments: AssignmentResult[] = [];

  // Initialize working copies
  const workingTeams: TeamBuilderTeam[] = teams.map(t => ({
    ...t,
    assignedPlayerIds: [],
    currentScore: 0,
  }));

  const unassignedPlayers = new Set(players.map(p => p.id));
  const playerMap = new Map(players.map(p => [p.id, p]));

  let currentRound = 1;
  let currentPick = 1;

  // Helper to assign a player
  const assignPlayer = (
    playerId: string,
    teamId: string,
    reason: AssignmentReason
  ) => {
    const player = playerMap.get(playerId);
    const team = workingTeams.find(t => t.id === teamId);

    if (!player || !team) {
      warnings.push(`Failed to assign player ${playerId} to team ${teamId}`);
      return false;
    }

    if (team.assignedPlayerIds.length >= fullConfig.maxRosterSize) {
      warnings.push(`Team ${team.teamName || team.headCoach} is full, cannot assign ${player.name}`);
      return false;
    }

    team.assignedPlayerIds.push(playerId);
    team.currentScore += player.totalScore;
    unassignedPlayers.delete(playerId);

    assignments.push({
      playerId,
      teamId,
      round: currentRound,
      pick: currentPick,
      reason,
    });

    currentPick++;
    if (currentPick > teams.length) {
      currentRound++;
      currentPick = 1;
    }

    return true;
  };

  // Calculate target roster sizes for even teams
  const numTeams = workingTeams.length;
  const totalPlayers = players.length;
  const baseRosterSize = Math.floor(totalPlayers / numTeams);
  const extraPlayers = totalPlayers % numTeams;
  const getMaxSizeForTeam = (team: TeamBuilderTeam): number => {
    if (!fullConfig.forceEvenTeams) {
      return fullConfig.maxRosterSize;
    }
    const teamsWithExtra = workingTeams.filter(t => t.assignedPlayerIds.length > baseRosterSize).length;
    const canHaveExtra = team.assignedPlayerIds.length > baseRosterSize || teamsWithExtra < extraPlayers;
    return Math.min(fullConfig.maxRosterSize, baseRosterSize + Number(canHaveExtra));
  };

  // Helper to check if team can accept more players
  const canAcceptPlayer = (team: TeamBuilderTeam): boolean => {
    const maxSize = getMaxSizeForTeam(team);
    return team.assignedPlayerIds.length < maxSize;
  };

  // Helper to get team with lowest score that can accept
  const getLowestScoreTeam = (): TeamBuilderTeam | null => {
    const eligible = workingTeams.filter(canAcceptPlayer);
    if (eligible.length === 0) return null;
    return eligible.reduce((lowest, team) =>
      team.currentScore < lowest.currentScore ? team : lowest
    );
  };

  // Helper to get team with fewest players that can accept (for even distribution)
  const getSmallestTeam = (): TeamBuilderTeam | null => {
    const eligible = workingTeams.filter(canAcceptPlayer);
    if (eligible.length === 0) return null;
    return eligible.reduce((smallest, team) =>
      team.assignedPlayerIds.length < smallest.assignedPlayerIds.length ? team : smallest
    );
  };

  // Build request lookup maps
  const playerRequests = new Map<string, ResolvedRequest[]>();
  for (const req of resolvedRequests) {
    if (!playerRequests.has(req.playerId)) {
      playerRequests.set(req.playerId, []);
    }
    playerRequests.get(req.playerId)!.push(req);
  }

  // =========================================================================
  // PHASE 0: Place locked players (coach kids, siblings)
  // =========================================================================

  // 0a: Coach kids
  for (const player of players) {
    if (!unassignedPlayers.has(player.id)) continue;

    if (player.isCoachKid && player.coachTeamId) {
      const team = workingTeams.find(t => t.id === player.coachTeamId);
      if (team && canAcceptPlayer(team)) {
        assignPlayer(player.id, team.id, 'coach-kid');
      }
    }
  }

  // 0c: Manually locked players
  for (const player of players) {
    if (!unassignedPlayers.has(player.id)) continue;

    if (player.lockedToTeamId) {
      const team = workingTeams.find(t => t.id === player.lockedToTeamId);
      if (team && canAcceptPlayer(team)) {
        assignPlayer(player.id, team.id, 'manual-lock');
      }
    }
  }

  const blockedSiblingIds = placeSiblingGroups(players, workingTeams, unassignedPlayers, assignPlayer,
    getMaxSizeForTeam, warnings);

  // =========================================================================
  // PHASE 1: Build and place two-way request clusters
  // =========================================================================

  // Build clusters from confirmed requests
  const confirmedRequests = resolvedRequests.filter(
    r => r.status === 'auto-confirmed' || r.status === 'user-confirmed'
  );

  let clusters = buildRequestClusters(
    confirmedRequests,
    players.map(p => ({ id: p.id, firstName: p.firstName, lastName: p.lastName })),
    fullConfig.maxRosterSize
  );

  // Split oversized clusters
  const processedClusters: RequestCluster[] = [];
  for (const cluster of clusters) {
    if (cluster.playerIds.length > fullConfig.maxRosterSize) {
      const split = splitOversizedCluster(cluster, confirmedRequests, fullConfig.maxRosterSize);
      processedClusters.push(...split);
    } else {
      processedClusters.push(cluster);
    }
  }
  clusters = processedClusters;

  // Sort clusters by weight (descending)
  clusters.sort((a, b) => b.totalWeight - a.totalWeight);

  // Place each cluster
  for (const cluster of clusters) {
    // Skip if all players already assigned
    const unassignedInCluster = cluster.playerIds.filter(id => unassignedPlayers.has(id) && !blockedSiblingIds.has(id));
    if (unassignedInCluster.length === 0) continue;

    // Find best team for this cluster
    // Prefer teams where some cluster members are already assigned
    // Then prefer teams with coach requests from cluster members
    // Then prefer team with lowest score

    let bestTeam: TeamBuilderTeam | null = null;
    let bestScore = -Infinity;

    for (const team of workingTeams) {
      if (!canAcceptPlayer(team)) continue;
      // Check if team can fit all unassigned cluster members
      const remainingCapacity = getMaxSizeForTeam(team) - team.assignedPlayerIds.length;
      if (remainingCapacity < unassignedInCluster.length) continue;

      let score = 0;

      // Bonus for cluster members already on team
      const alreadyOnTeam = cluster.playerIds.filter(id =>
        team.assignedPlayerIds.includes(id)
      ).length;
      score += alreadyOnTeam * 200;

      // Bonus for coach request preference
      if (cluster.preferredTeamIds.includes(team.id)) {
        score += fullConfig.coachRequestWeight;
      }

      // Small penalty for team score (prefer lower-score teams slightly)
      score -= team.currentScore * 0.01;

      if (score > bestScore) {
        bestScore = score;
        bestTeam = team;
      }
    }

    // If no team can fit the whole cluster, pick team with most capacity
    if (!bestTeam) {
      const teamsWithCapacity = workingTeams
        .filter(canAcceptPlayer)
        .sort((a, b) => {
          const capA = getMaxSizeForTeam(a) - a.assignedPlayerIds.length;
          const capB = getMaxSizeForTeam(b) - b.assignedPlayerIds.length;
          return capB - capA;
        });
      bestTeam = teamsWithCapacity[0] || null;
    }

    if (bestTeam) {
      for (const playerId of unassignedInCluster) {
        if (canAcceptPlayer(bestTeam)) {
          assignPlayer(playerId, bestTeam.id, 'two-way-friend');
        } else {
          warnings.push(`Could not place all cluster members together: ${playerId}`);
        }
      }
    } else {
      for (const playerId of unassignedInCluster) {
        warnings.push(`No team available for cluster member: ${playerId}`);
      }
    }
  }

  // =========================================================================
  // PHASE 2: Place remaining players by request weight
  // =========================================================================

  // Calculate request weight for each remaining player
  interface PlayerWeight {
    playerId: string;
    weight: number;
    preferredTeamIds: string[];
    oneWayTargets: string[];
  }

  const playerWeights: PlayerWeight[] = [];

  for (const playerId of unassignedPlayers) {
    if (blockedSiblingIds.has(playerId)) continue;
    const requests = playerRequests.get(playerId) || [];
    let weight = 0;
    const preferredTeamIds: string[] = [];
    const oneWayTargets: string[] = [];

    for (const req of requests) {
      if (req.status !== 'auto-confirmed' && req.status !== 'user-confirmed') continue;
      if (!req.resolvedTargetId) continue;

      if (req.requestType === 'coach') {
        weight += fullConfig.coachRequestWeight;
        preferredTeamIds.push(req.resolvedTargetId);
      } else if (req.requestType === 'teammate') {
        if (req.isTwoWay) {
          weight += fullConfig.twoWayTeammateWeight;
        } else {
          weight += fullConfig.oneWayTeammateWeight;
          oneWayTargets.push(req.resolvedTargetId);
        }
      }
    }

    // Add school cluster weight if player has school
    const player = playerMap.get(playerId);
    if (player?.school) {
      weight += fullConfig.schoolClusterWeight;
    }

    playerWeights.push({
      playerId,
      weight,
      preferredTeamIds,
      oneWayTargets,
    });
  }

  // Sort by weight descending (players with more/higher-priority requests first)
  playerWeights.sort((a, b) => b.weight - a.weight);

  // Place each player to maximize their request satisfaction
  for (const { playerId, preferredTeamIds, oneWayTargets } of playerWeights) {
    if (!unassignedPlayers.has(playerId)) continue;

    const player = playerMap.get(playerId);
    if (!player) continue;

    let bestTeam: TeamBuilderTeam | null = null;
    let bestScore = -Infinity;
    let bestReason: AssignmentReason = 'balance';

    for (const team of workingTeams) {
      if (!canAcceptPlayer(team)) continue;

      let score = 0;
      let reason: AssignmentReason = 'balance';

      // Check one-way targets on this team
      const oneWayOnTeam = oneWayTargets.filter(targetId =>
        team.assignedPlayerIds.includes(targetId)
      ).length;
      if (oneWayOnTeam > 0) {
        score += oneWayOnTeam * fullConfig.oneWayTeammateWeight;
        reason = 'one-way-friend';
      }

      // Check coach preference
      if (preferredTeamIds.includes(team.id)) {
        score += fullConfig.coachRequestWeight;
        if (reason === 'balance') reason = 'coach-request';
      }

      // Check school clustering
      if (player.school) {
        const schoolmatesOnTeam = team.assignedPlayerIds.filter(id => {
          const p = playerMap.get(id);
          return p?.school && p.school.toLowerCase() === player.school!.toLowerCase();
        }).length;
        if (schoolmatesOnTeam > 0) {
          score += schoolmatesOnTeam * fullConfig.schoolClusterWeight;
          if (reason === 'balance') reason = 'school-cluster';
        }
      }

      // Small penalty for team score (prefer lower-score teams for balance)
      score -= team.currentScore * 0.001;

      if (score > bestScore) {
        bestScore = score;
        bestTeam = team;
        bestReason = reason;
      }
    }

    // If no team with requests, use smallest team (for even teams) or lowest score team
    if (!bestTeam || bestScore <= 0) {
      bestTeam = fullConfig.forceEvenTeams ? getSmallestTeam() : getLowestScoreTeam();
      bestReason = 'balance';
    }

    if (bestTeam) {
      assignPlayer(playerId, bestTeam.id, bestReason);
    } else {
      warnings.push(`No team available for player: ${player.name}`);
    }
  }

  // =========================================================================
  // PHASE 3: Place any remaining unassigned players
  // =========================================================================

  for (const playerId of unassignedPlayers) {
    if (blockedSiblingIds.has(playerId)) continue;
    const player = playerMap.get(playerId);
    if (!player) continue;

    // Use smallest team for even distribution, or lowest score team otherwise
    const targetTeam = fullConfig.forceEvenTeams ? getSmallestTeam() : getLowestScoreTeam();
    if (targetTeam) {
      assignPlayer(playerId, targetTeam.id, 'balance');
    } else {
      warnings.push(`Could not place player ${player.name} - all teams full`);
    }
  }

  // =========================================================================
  // PHASE 4: Calculate suggested trades for balance
  // =========================================================================

  fillMinimumRosters(players, workingTeams, assignments, fullConfig, warnings, resolvedRequests);

  const suggestedTrades = findBalancingTrades(
    workingTeams,
    players,
    resolvedRequests,
    assignments,
    fullConfig
  );

  // =========================================================================
  // Calculate results
  // =========================================================================

  // Team summaries
  const teamAverages = workingTeams.map(team => ({
    team,
    averageScore: team.assignedPlayerIds.length > 0
      ? team.currentScore / team.assignedPlayerIds.length
      : 0,
  }));
  const meanAverageScore = teamAverages.length > 0
    ? teamAverages.reduce((sum, t) => sum + t.averageScore, 0) / teamAverages.length
    : 0;

  const teamSummaries: TeamSummary[] = workingTeams.map(team => {
    const rosterCount = team.assignedPlayerIds.length;
    const averageScore = rosterCount > 0 ? team.currentScore / rosterCount : 0;
    return {
      teamId: team.id,
      teamName: getTeamDisplayName(team),
      coachName: team.headCoach,
      rosterCount,
      totalScore: team.currentScore,
      averageScore,
      meanDelta: averageScore - meanAverageScore,
      meanDeltaPercent: meanAverageScore > 0 ? ((averageScore - meanAverageScore) / meanAverageScore) * 100 : 0,
    };
  });

  // Player happiness
  const playerHappiness: PlayerHappiness[] = players.map(player => {
    const assignment = assignments.find(a => a.playerId === player.id);
    if (!assignment) {
      return {
        playerId: player.id,
        score: 'no-requests' as HappinessScore,
        coachRequestHonored: null,
        teammateRequestsHonored: 0,
        teammateRequestsTotal: 0,
        twoWayRequestsHonored: 0,
        twoWayRequestsTotal: 0,
      };
    }

    const teamId = assignment.teamId;
    const team = workingTeams.find(t => t.id === teamId)!;
    const requests = playerRequests.get(player.id) || [];

    // Coach request
    const coachRequests = requests.filter(r =>
      r.requestType === 'coach' &&
      (r.status === 'auto-confirmed' || r.status === 'user-confirmed') &&
      r.resolvedTargetId
    );
    const hasCoachRequest = coachRequests.length > 0;
    const coachRequestHonored = hasCoachRequest
      ? coachRequests.some(r => r.resolvedTargetId === teamId)
      : null;

    // Teammate requests
    const teammateRequests = requests.filter(r =>
      r.requestType === 'teammate' &&
      (r.status === 'auto-confirmed' || r.status === 'user-confirmed') &&
      r.resolvedTargetId
    );

    const twoWayTotal = teammateRequests.filter(r => r.isTwoWay).length;
    const oneWayTotal = teammateRequests.filter(r => !r.isTwoWay).length;
    const teammateRequestsTotal = twoWayTotal + oneWayTotal;

    const twoWayHonored = teammateRequests.filter(r =>
      r.isTwoWay && team.assignedPlayerIds.includes(r.resolvedTargetId!)
    ).length;
    const oneWayHonored = teammateRequests.filter(r =>
      !r.isTwoWay && team.assignedPlayerIds.includes(r.resolvedTargetId!)
    ).length;
    const teammateRequestsHonored = twoWayHonored + oneWayHonored;

    // Calculate happiness score
    let score: HappinessScore;
    const totalRequests = teammateRequestsTotal + (hasCoachRequest ? 1 : 0);
    const totalHonored = teammateRequestsHonored + (coachRequestHonored ? 1 : 0);

    if (totalRequests === 0) {
      score = 'no-requests';
    } else if (totalHonored === totalRequests) {
      score = 'all';
    } else if (totalHonored > 0) {
      score = 'some';
    } else {
      score = 'none';
    }

    return {
      playerId: player.id,
      score,
      coachRequestHonored,
      teammateRequestsHonored,
      teammateRequestsTotal,
      twoWayRequestsHonored: twoWayHonored,
      twoWayRequestsTotal: twoWayTotal,
    };
  });

  // Stats
  const lockedCount = assignments.filter(a =>
    ['coach-kid', 'assistant-coach-kid', 'sibling-lock', 'manual-lock'].includes(a.reason)
  ).length;

  const topTalentAssigned = assignments.filter(a => a.reason === 'top-talent').length;

  const requestBasedCount = assignments.filter(a =>
    ['two-way-friend', 'one-way-friend', 'coach-request', 'school-cluster'].includes(a.reason)
  ).length;

  const balanceBasedCount = assignments.filter(a => a.reason === 'balance').length;

  const twoWayTotal = players.reduce((sum, p) => sum + (p.twoWayTeammateIds?.length || 0), 0);
  const twoWayHonored = playerHappiness.reduce((sum, h) => sum + h.twoWayRequestsHonored, 0);

  const oneWayTotal = players.reduce((sum, p) => sum + (p.oneWayTeammateIds?.length || 0), 0);
  const oneWayHonored = playerHappiness.reduce((sum, h) =>
    sum + (h.teammateRequestsHonored - h.twoWayRequestsHonored), 0
  );

  const coachRequestTotal = players.filter(p => p.resolvedCoachTeamId).length;
  const coachRequestHonored = playerHappiness.filter(h => h.coachRequestHonored === true).length;

  // Average happiness
  const happinessScores = playerHappiness.filter(h => h.score !== 'no-requests');
  const avgHappiness = happinessScores.length > 0
    ? happinessScores.reduce((sum, h) => {
        if (h.score === 'all') return sum + 1;
        if (h.score === 'some') return sum + 0.5;
        return sum;
      }, 0) / happinessScores.length
    : 1;

  return {
    assignments,
    teamSummaries,
    playerHappiness,
    warnings,
    stats: {
      totalPlayers: players.length,
      lockedPlayers: lockedCount,
      topTalentPlayers: topTalentAssigned,
      requestBasedPlayers: requestBasedCount,
      balanceBasedPlayers: balanceBasedCount,
      twoWayRequestsHonored: twoWayHonored,
      twoWayRequestsTotal: twoWayTotal,
      oneWayRequestsHonored: oneWayHonored,
      oneWayRequestsTotal: oneWayTotal,
      coachRequestsHonored: coachRequestHonored,
      coachRequestsTotal: coachRequestTotal,
      averageHappiness: avgHappiness,
    },
    clusters,
    suggestedTrades,
  };
}

// -----------------------------------------------------------------------------
// Trade Suggestions for Balance
// -----------------------------------------------------------------------------

/**
 * Find trades that would improve team balance without breaking satisfied requests.
 *
 * A player is "tradeable" if:
 * - They have NO requests, OR
 * - ALL their requests are already satisfied on their current team
 */
export function findBalancingTrades(
  teams: TeamBuilderTeam[],
  players: TeamBuilderPlayer[],
  resolvedRequests: ResolvedRequest[],
  assignments: AssignmentResult[],
  config: RequestsFirstConfig
): TradeCandidate[] {
  const candidates: TradeCandidate[] = [];
  const playerMap = new Map(players.map(p => [p.id, p]));

  // Build lookup for which team each player is on
  const playerTeamMap = new Map<string, string>();
  for (const assignment of assignments) {
    playerTeamMap.set(assignment.playerId, assignment.teamId);
  }

  // Build request lookup
  const playerRequests = new Map<string, ResolvedRequest[]>();
  for (const req of resolvedRequests) {
    if (!playerRequests.has(req.playerId)) {
      playerRequests.set(req.playerId, []);
    }
    playerRequests.get(req.playerId)!.push(req);
  }

  // Determine which players are tradeable
  const isPlayerTradeable = (playerId: string): boolean => {
    const player = playerMap.get(playerId);
    if (!player) return false;

    // Coach kids are never tradeable
    if (player.isCoachKid) return false;

    // Siblings are not tradeable (would need to trade both)
    if (player.siblingId) return false;

    // Players locked to teams are not tradeable
    if (player.lockedToTeamId) return false;

    const requests = playerRequests.get(playerId) || [];
    const confirmedRequests = requests.filter(
      r => (r.status === 'auto-confirmed' || r.status === 'user-confirmed') && r.resolvedTargetId
    );

    // If no confirmed requests, player is tradeable
    if (confirmedRequests.length === 0) return true;

    // Check if all requests are satisfied
    const teamId = playerTeamMap.get(playerId);
    const team = teams.find(t => t.id === teamId);
    if (!team) return false;

    for (const req of confirmedRequests) {
      if (req.requestType === 'coach') {
        // Coach request satisfied if on requested team
        if (req.resolvedTargetId !== teamId) return false;
      } else {
        // Teammate request satisfied if teammate is on same team
        if (!team.assignedPlayerIds.includes(req.resolvedTargetId!)) return false;
      }
    }

    return true;
  };

  // Get tradeable players per team with their scores
  const tradeableByTeam = new Map<string, Array<{ playerId: string; score: number; name: string }>>();
  for (const team of teams) {
    const tradeable: Array<{ playerId: string; score: number; name: string }> = [];
    for (const playerId of team.assignedPlayerIds) {
      if (isPlayerTradeable(playerId)) {
        const player = playerMap.get(playerId);
        if (player) {
          tradeable.push({
            playerId,
            score: player.totalScore,
            name: player.name,
          });
        }
      }
    }
    tradeableByTeam.set(team.id, tradeable);
  }

  // Calculate current balance metrics
  const teamScores = teams.map(t => ({
    team: t,
    avgScore: t.assignedPlayerIds.length > 0
      ? t.currentScore / t.assignedPlayerIds.length
      : 0,
  }));
  const meanAvg = teamScores.reduce((sum, t) => sum + t.avgScore, 0) / teamScores.length;

  // Sort teams by average score
  teamScores.sort((a, b) => b.avgScore - a.avgScore);

  // Find trades between high and low scoring teams
  let tradeId = 0;
  for (let i = 0; i < teamScores.length; i++) {
    for (let j = teamScores.length - 1; j > i; j--) {
      const highTeam = teamScores[i].team;
      const lowTeam = teamScores[j].team;

      // Get tradeable players
      const highTradeable = tradeableByTeam.get(highTeam.id) || [];
      const lowTradeable = tradeableByTeam.get(lowTeam.id) || [];

      // Try to find beneficial swaps
      for (const highPlayer of highTradeable) {
        for (const lowPlayer of lowTradeable) {
          // Only consider if high player has more points
          if (highPlayer.score <= lowPlayer.score) continue;

          // Calculate new averages after trade
          const newHighTotal = highTeam.currentScore - highPlayer.score + lowPlayer.score;
          const newLowTotal = lowTeam.currentScore - lowPlayer.score + highPlayer.score;

          const newHighAvg = newHighTotal / highTeam.assignedPlayerIds.length;
          const newLowAvg = newLowTotal / lowTeam.assignedPlayerIds.length;

          // Calculate improvement (how much closer to mean)
          const oldHighDelta = Math.abs(teamScores[i].avgScore - meanAvg);
          const oldLowDelta = Math.abs(teamScores[j].avgScore - meanAvg);
          const newHighDelta = Math.abs(newHighAvg - meanAvg);
          const newLowDelta = Math.abs(newLowAvg - meanAvg);

          const improvement = (oldHighDelta + oldLowDelta) - (newHighDelta + newLowDelta);

          // Only suggest if it improves balance
          if (improvement > 0) {
            candidates.push({
              id: `trade-${tradeId++}`,
              fromTeamId: highTeam.id,
              toTeamId: lowTeam.id,
              player1Id: highPlayer.playerId,
              player2Id: lowPlayer.playerId,
              balanceImprovement: improvement,
              player1Name: highPlayer.name,
              player2Name: lowPlayer.name,
              fromTeamName: highTeam.teamName || highTeam.headCoach,
              toTeamName: lowTeam.teamName || lowTeam.headCoach,
            });
          }
        }
      }
    }
  }

  // Sort by improvement (descending) and limit
  candidates.sort((a, b) => b.balanceImprovement - a.balanceImprovement);

  // Deduplicate - remove trades involving same players
  const seen = new Set<string>();
  const unique: TradeCandidate[] = [];
  for (const trade of candidates) {
    const key1 = trade.player1Id;
    const key2 = trade.player2Id;
    if (!seen.has(key1) && !seen.has(key2)) {
      unique.push(trade);
      seen.add(key1);
      seen.add(key2);
    }
  }

  return unique.slice(0, config.maxAutoTrades);
}

/**
 * Apply a trade to update team assignments.
 */
export function applyTrade(
  teams: TeamBuilderTeam[],
  assignments: AssignmentResult[],
  trade: TradeCandidate
): { teams: TeamBuilderTeam[]; assignments: AssignmentResult[] } {
  // Clone data
  const newTeams = teams.map(t => ({
    ...t,
    assignedPlayerIds: [...t.assignedPlayerIds],
  }));
  const newAssignments = [...assignments];

  // Find teams
  const fromTeam = newTeams.find(t => t.id === trade.fromTeamId);
  const toTeam = newTeams.find(t => t.id === trade.toTeamId);

  if (!fromTeam || !toTeam) return { teams, assignments };

  // Update team rosters
  fromTeam.assignedPlayerIds = fromTeam.assignedPlayerIds
    .filter(id => id !== trade.player1Id);
  fromTeam.assignedPlayerIds.push(trade.player2Id);

  toTeam.assignedPlayerIds = toTeam.assignedPlayerIds
    .filter(id => id !== trade.player2Id);
  toTeam.assignedPlayerIds.push(trade.player1Id);

  // Update assignments
  const a1Idx = newAssignments.findIndex(a => a.playerId === trade.player1Id);
  const a2Idx = newAssignments.findIndex(a => a.playerId === trade.player2Id);

  if (a1Idx >= 0) {
    newAssignments[a1Idx] = { ...newAssignments[a1Idx], teamId: trade.toTeamId };
  }
  if (a2Idx >= 0) {
    newAssignments[a2Idx] = { ...newAssignments[a2Idx], teamId: trade.fromTeamId };
  }

  return { teams: newTeams, assignments: newAssignments };
}
