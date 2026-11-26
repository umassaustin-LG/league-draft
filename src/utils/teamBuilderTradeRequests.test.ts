import { describe, expect, it } from 'vitest';
import { Player, Team, ResolvedRequest, DEFAULT_REQUESTS_FIRST_CONFIG } from '../types';
import { AssignmentResult, TeamBuilderTeam, findBalancingTrades, runRequestsFirstAlgorithm, summarizeTeamBuilderAssignments } from './teamBuilderAlgorithm';

const players = [100, 80, 40, 20].map((totalScore, i) => ({ id: `p${i}`, name: `Player ${i}`, totalScore } as Player));
const assignments: AssignmentResult[] = players.map((p, i) => ({
  playerId: p.id, teamId: i < 2 ? 'high' : 'low', round: 1, pick: i + 1, reason: 'balance',
}));
const teams: TeamBuilderTeam[] = ['high', 'low'].map((id, i) => ({
  id, teamName: id, headCoach: id, assignedPlayerIds: players.slice(i * 2, i * 2 + 2).map(p => p.id),
  currentScore: i === 0 ? 180 : 60, roster: [], totalScore: 0,
  assistantCoach: '', draftPosition: i + 1, coachKids: [], ageBreakdown: {},
}));
const request = (playerId: string, target: string, requestType: 'coach' | 'teammate' = 'teammate'): ResolvedRequest => ({
  id: `${playerId}-${target}`, playerId, requestType, rawRequestString: target,
  resolvedTargetId: target, resolvedTargetName: target, status: 'user-confirmed', confidenceScore: 1, isTwoWay: requestType === 'teammate',
});

describe('balancing trades preserve satisfied confirmed requests', () => {
  it('rejects a balancing swap that would split reciprocal friends, initially and when recomputed', () => {
    const requests = [request('p0', 'p1'), request('p1', 'p0')];
    expect(findBalancingTrades(teams, players, [], assignments, DEFAULT_REQUESTS_FIRST_CONFIG).length).toBeGreaterThan(0);
    expect(findBalancingTrades(teams, players, requests, assignments, DEFAULT_REQUESTS_FIRST_CONFIG)).toEqual([]);
    const recomputed = summarizeTeamBuilderAssignments(players, teams, assignments, requests);
    expect(recomputed.stats.twoWayRequestsHonored).toBe(2);
    expect(recomputed.suggestedTrades).toEqual([]);

    const initial = runRequestsFirstAlgorithm(players, teams as Team[], requests, { maxRosterSize: 2, minRosterSize: 2 });
    expect(initial.stats.twoWayRequestsHonored).toBe(2);
    expect(initial.suggestedTrades).toEqual([]);
  });

  it('protects satisfied incoming requests even when the traded player made no request', () => {
    const roster = players.map(p => p.id === 'p1' ? { ...p, lockedToTeamId: 'high' } : p);
    const incoming = { ...request('p1', 'p0'), isTwoWay: false };
    expect(findBalancingTrades(teams, roster, [incoming], assignments, DEFAULT_REQUESTS_FIRST_CONFIG)).toEqual([]);
  });

  it('rejects a swap away from a requested coach and ignores unconfirmed matches', () => {
    const roster = players.map(p => p.id === 'p1' ? { ...p, lockedToTeamId: 'high' } : p);
    const coach = request('p0', 'high', 'coach');
    expect(findBalancingTrades(teams, roster, [coach], assignments, DEFAULT_REQUESTS_FIRST_CONFIG)).toEqual([]);
    expect(findBalancingTrades(teams, roster, [{ ...coach, status: 'needs-review' }], assignments, DEFAULT_REQUESTS_FIRST_CONFIG).length).toBeGreaterThan(0);
    expect(findBalancingTrades([], [], [], [], DEFAULT_REQUESTS_FIRST_CONFIG)).toEqual([]);
  });
});
