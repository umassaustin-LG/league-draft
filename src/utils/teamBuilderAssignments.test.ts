import { describe, expect, it } from 'vitest';
import { Player, Team } from '../types';
import { applyAssignments } from './teamBuilderAlgorithm';

const players = Array.from({ length: 70 }, (_, i) => ({
  id: `p${i}`, totalScore: 10, littleLeagueAge: 8, isDrafted: true,
  draftedByTeamId: `t${i % 5}`, draftedInRound: 14, draftedAtPick: i,
} as Player));
const teams = Array.from({ length: 5 }, (_, i) => ({
  id: `t${i}`, totalScore: 140, roster: players.filter(p => p.draftedByTeamId === `t${i}`),
} as Team));

describe('replacing Team Builder assignments', () => {
  it('clears old assignments for players omitted by a smaller cap', () => {
    const assignments = players.slice(0, 65).map((p, i) => ({
      playerId: p.id, teamId: `t${i % 5}`, round: Math.floor(i / 5) + 1, pick: i + 1, reason: 'balance' as const,
    }));
    const result = applyAssignments(players, teams, assignments);
    expect(result.players.filter(p => p.isDrafted)).toHaveLength(65);
    for (const omitted of result.players.slice(65)) {
      expect(omitted.isDrafted).toBe(false);
      expect(omitted.draftedByTeamId).toBeUndefined();
      expect(omitted.draftedInRound).toBeUndefined();
      expect(omitted.draftedAtPick).toBeUndefined();
    }
    expect(players.every(p => p.isDrafted)).toBe(true);
  });

  it('clears all rosters and scores for empty or invalid assignments', () => {
    const result = applyAssignments(players, teams, [{
      playerId: 'missing', teamId: 'missing', round: 1, pick: 1, reason: 'balance',
    }]);
    expect(result.players.every(p => !p.isDrafted && !p.draftedByTeamId)).toBe(true);
    expect(result.teams.every(t => t.roster.length === 0 && t.totalScore === 0)).toBe(true);
  });
});
