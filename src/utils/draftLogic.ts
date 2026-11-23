import { Player } from '../types';

export interface MandatoryPickResult {
  player: Player;
  reason: 'coach-kid' | 'sibling';
  siblingName?: string;
}

/**
 * Get the effective round for a player (locked round takes precedence over projected)
 */
function getEffectiveRound(player: Player): number {
  return player.lockedToRound ?? player.projectedRound ?? 999;
}

/**
 * Get mandatory pick for a team in a given round.
 * This is the SINGLE SOURCE OF TRUTH for mandatory pick logic.
 * Used by both the real draft (useDraft.ts) and simulation (simulation.ts).
 *
 * Logic:
 * 1. First check if there's a mandatory pick due THIS round (projected/locked round matches)
 * 2. If not, check if we need to force a mandatory pick early because there aren't
 *    enough remaining picks to draft all required players at their projected rounds
 */
export function getMandatoryPick(
  players: Player[],
  teamId: string,
  round: number,
  options: { includeCoachKids: boolean; includeSiblings: boolean; totalRounds?: number; teamPicksMade?: number } = { includeCoachKids: true, includeSiblings: true }
): MandatoryPickResult | null {
  // Check for coach's kids that must be drafted this round
  if (options.includeCoachKids) {
    const coachKidToDraft = players.find(
      (p) =>
        !p.isDrafted &&
        p.isCoachKid &&
        p.coachTeamId === teamId &&
        (p.lockedToRound ?? p.projectedRound) === round
    );

    if (coachKidToDraft) {
      return {
        player: coachKidToDraft,
        reason: 'coach-kid',
      };
    }
  }

  // Check for sibling requirements
  if (options.includeSiblings) {
    const siblingToDraft = players.find((p) => {
      if (p.isDrafted || !p.siblingId) return false;

      // If locked to this team, must draft in their lockedToRound or projectedRound
      if (p.lockedToTeamId === teamId) {
        const requiredRound = p.lockedToRound ?? p.projectedRound;
        return requiredRound === round;
      }

      // Legacy check: sibling by name match in effective round
      if (p.sibling && (p.lockedToRound ?? p.projectedRound) === round) {
        const sibling = players.find(
          (other) =>
            other.name.toLowerCase() === p.sibling!.toLowerCase() &&
            other.draftedByTeamId === teamId
        );
        return !!sibling;
      }

      return false;
    });

    if (siblingToDraft) {
      const siblingPlayer = players.find(p => p.id === siblingToDraft.siblingId);
      return {
        player: siblingToDraft,
        reason: 'sibling',
        siblingName: siblingPlayer?.name || siblingToDraft.sibling,
      };
    }
  }

  // Check if we need to force a mandatory pick early due to insufficient remaining picks
  // Only if totalRounds is provided (simulation passes this)
  if (options.totalRounds !== undefined && options.teamPicksMade !== undefined) {
    const remainingPicks = options.totalRounds - options.teamPicksMade;

    // Get all undrafted mandatory players for this team
    const allMandatory: { player: Player; reason: 'coach-kid' | 'sibling' }[] = [];

    if (options.includeCoachKids) {
      const coachKids = players.filter(
        (p) => !p.isDrafted && p.isCoachKid && p.coachTeamId === teamId
      );
      coachKids.forEach(p => allMandatory.push({ player: p, reason: 'coach-kid' }));
    }

    if (options.includeSiblings) {
      const lockedSiblings = players.filter(
        (p) =>
          !p.isDrafted &&
          p.lockedToTeamId === teamId &&
          // Exclude coach's kids already counted
          !(p.isCoachKid && p.coachTeamId === teamId)
      );
      lockedSiblings.forEach(p => allMandatory.push({ player: p, reason: 'sibling' }));
    }

    if (allMandatory.length > 0 && allMandatory.length >= remainingPicks) {
      // Must draft a mandatory player now - not enough picks left to wait
      // Pick the one with the earliest effective round
      allMandatory.sort((a, b) => getEffectiveRound(a.player) - getEffectiveRound(b.player));
      const forced = allMandatory[0];

      if (forced.reason === 'sibling') {
        const siblingPlayer = players.find(p => p.id === forced.player.siblingId);
        return {
          player: forced.player,
          reason: 'sibling',
          siblingName: siblingPlayer?.name || forced.player.sibling,
        };
      }

      return {
        player: forced.player,
        reason: 'coach-kid',
      };
    }
  }

  return null;
}

/**
 * Lock a sibling to follow the drafted player to their team.
 * Call this after drafting a player who has siblings.
 * Handles both directions of the sibling link and follows chains for 3+ sibling groups.
 */
export function lockSiblingToTeam(
  players: Player[],
  draftedPlayer: Player,
  teamId: string
): void {
  // Track which players we've already processed to avoid infinite loops
  const processed = new Set<string>([draftedPlayer.id]);
  const toProcess: Player[] = [draftedPlayer];

  while (toProcess.length > 0) {
    const current = toProcess.shift()!;

    // Check current player's siblingId (forward direction)
    if (current.siblingId) {
      const sibling = players.find(p => p.id === current.siblingId);
      if (sibling && !sibling.isDrafted && !processed.has(sibling.id)) {
        sibling.lockedToTeamId = teamId;
        processed.add(sibling.id);
        toProcess.push(sibling); // Follow the chain
      }
    }

    // Also check for any players whose siblingId points to current (reverse direction)
    players.forEach(p => {
      if (p.siblingId === current.id && !p.isDrafted && !processed.has(p.id)) {
        p.lockedToTeamId = teamId;
        processed.add(p.id);
        toProcess.push(p); // Follow the chain
      }
    });
  }
}

/**
 * Get the best available player for a team (highest score, not drafted, not restricted).
 * When options.includeCoachKids is true, excludes coach's kids assigned to OTHER teams.
 * When options.includeSiblings is true, excludes siblings locked to OTHER teams.
 * When these options are false, those players are treated as regular available players.
 */
export function getBestAvailable(
  players: Player[],
  currentTeamId?: string,
  options: { includeCoachKids: boolean; includeSiblings: boolean } = { includeCoachKids: true, includeSiblings: true }
): Player | null {
  return players
    .filter(p => {
      if (p.isDrafted) return false;

      // Only exclude coach's kids from other teams if includeCoachKids is ON
      if (options.includeCoachKids && p.isCoachKid && p.coachTeamId && p.coachTeamId !== currentTeamId) {
        return false;
      }

      // Only exclude siblings locked to other teams if includeSiblings is ON
      if (options.includeSiblings && p.lockedToTeamId && p.lockedToTeamId !== currentTeamId) {
        return false;
      }

      return true;
    })
    .sort((a, b) => b.totalScore - a.totalScore)[0] || null;
}
