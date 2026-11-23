import { describe, expect, it } from 'vitest';
import { fillMinimumRosters, AssignmentResult, TeamBuilderPlayer, TeamBuilderTeam } from './teamBuilderAlgorithm';

const player = (id: string, extra = {}): TeamBuilderPlayer => ({ id, totalScore: 10, ...extra } as TeamBuilderPlayer);
const team = (id: string, ids: string[]): TeamBuilderTeam => ({
  id, assignedPlayerIds: ids, currentScore: ids.length * 10, draftPosition: 1,
} as TeamBuilderTeam);
const assignments = (teams: TeamBuilderTeam[]): AssignmentResult[] => teams.flatMap(t =>
  t.assignedPlayerIds.map(id => ({ playerId: id, teamId: t.id, reason: 'balance', round: 1, pick: 1 }))
);
const config = { minRosterSize: 2, maxRosterSize: 5, forceEvenTeams: false };

describe('minimum roster group selection', () => {
  it('moves a pair before a singleton when only the pair can fill the deficit', () => {
    const players = [player('single'), player('a', { siblingId: 'b' }), player('b', { siblingId: 'a' }),
      player('lock1', { lockedToTeamId: 'donor' }), player('lock2', { lockedToTeamId: 'donor' })];
    const teams = [team('donor', players.map(p => p.id)), team('empty', [])];
    const picks = assignments(teams);
    const warnings: string[] = [];
    fillMinimumRosters(players, teams, picks, config, warnings);
    expect(teams.map(t => t.assignedPlayerIds.length)).toEqual([3, 2]);
    expect(teams[1].assignedPlayerIds).toEqual(['a', 'b']);
    expect(warnings).toEqual([]);
  });
});
