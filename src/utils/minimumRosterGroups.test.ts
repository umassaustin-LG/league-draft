import { describe, expect, it } from 'vitest';
import { fillMinimumRosters, AssignmentResult, TeamBuilderPlayer, TeamBuilderTeam } from './teamBuilderAlgorithm';
import { ResolvedRequest } from '../types';

const player = (id: string, extra = {}): TeamBuilderPlayer => ({ id, totalScore: 10, ...extra } as TeamBuilderPlayer);
const team = (id: string, ids: string[]): TeamBuilderTeam => ({
  id, assignedPlayerIds: ids, currentScore: ids.length * 10, draftPosition: 1,
} as TeamBuilderTeam);
const assignments = (teams: TeamBuilderTeam[]): AssignmentResult[] => teams.flatMap(t =>
  t.assignedPlayerIds.map(id => ({ playerId: id, teamId: t.id, reason: 'balance', round: 1, pick: 1 }))
);
const config = { minRosterSize: 2, maxRosterSize: 5, forceEvenTeams: false };
const request = (id: string, target: string, status: ResolvedRequest['status'] = 'user-confirmed'): ResolvedRequest => ({
  id, playerId: id, requestType: 'teammate', rawRequestString: target,
  resolvedTargetId: target, resolvedTargetName: target, status, confidenceScore: 1, isTwoWay: false,
});

describe('minimum roster group selection', () => {
  it('moves an unrequested player instead of breaking a satisfied mutual friendship', () => {
    const players = [player('a', { resolvedTeammateIds: ['b'] }), player('b', { resolvedTeammateIds: ['a'] }),
      player('free'), player('locked', { lockedToTeamId: 'short' })];
    const teams = [team('donor', ['a', 'b', 'free']), team('short', ['locked'])];
    const picks = assignments(teams);
    fillMinimumRosters(players, teams, picks, config, [], [request('a', 'b'), request('b', 'a')]);
    expect(teams[0].assignedPlayerIds).toEqual(['a', 'b']);
    expect(teams[1].assignedPlayerIds).toEqual(['locked', 'free']);
  });

  it('ignores discarded original matches and honors the admin-corrected request', () => {
    const players = [player('a', { resolvedTeammateIds: ['b'] }), player('b', { resolvedTeammateIds: ['a'] }),
      player('free'), player('locked', { lockedToTeamId: 'short' })];
    const teams = [team('donor', ['a', 'b', 'free']), team('short', ['locked'])];
    fillMinimumRosters(players, teams, assignments(teams), config, [], [
      request('a', 'free'), request('b', 'a', 'unresolvable'),
    ]);
    expect(teams[0].assignedPlayerIds).toEqual(['a', 'free']);
    expect(teams[1].assignedPlayerIds).toEqual(['locked', 'b']);
  });

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
