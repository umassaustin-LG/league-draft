import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { Player, Team, ResolvedRequest } from '../types';
import { TeamBuilderResults } from '../components/teamBuilder/TeamBuilderResults';
import { AssignmentResult, summarizeTeamBuilderAssignments } from './teamBuilderAlgorithm';
import { isSuggestedTradeCurrent } from './teamBuilderTrades';
import { confirmTeamBuilderFinalization } from './teamBuilderCompletion';

const players = [90, 71.2, 65, 46.2].map((totalScore, i) => ({
  id: `p${i}`, name: `Player ${i}`, firstName: 'Player', lastName: String(i), totalScore,
} as Player));
const teams = ['Pine', 'Ash'].map((teamName, i) => ({ id: `t${i}`, teamName, headCoach: teamName } as Team));
const assignment = (playerId: string, teamId: string): AssignmentResult => ({ playerId, teamId, round: 1, pick: 1, reason: 'balance' });
const assignments = players.map((p, i) => assignment(p.id, `t${Math.floor(i / 2)}`));
const requests: ResolvedRequest[] = [{
  id: 'r1', playerId: 'p0', requestType: 'coach', rawRequestString: 'Pine',
  resolvedTargetId: 't0', resolvedTargetName: 'Pine', status: 'user-confirmed', confidenceScore: 1, isTwoWay: false,
}];

describe('results after roster edits', () => {
  it('counts confirmed requests from unassigned players as unsatisfied', () => {
    const allRequests = [requests[0], { ...requests[0], id: 'r2', playerId: 'p2', resolvedTargetId: 't1' }];
    const result = summarizeTeamBuilderAssignments(players, teams, assignments.slice(0, 2), allRequests);
    expect(result.stats.requestingPlayers).toBe(2);
    expect(result.stats.coachRequestsTotal).toBe(2);
    expect(result.stats.averageHappiness).toBe(0.5);
    expect(result.playerHappiness.find(h => h.playerId === 'p2')?.score).toBe('none');
    const html = renderToStaticMarkup(createElement(TeamBuilderResults, { result, players }));
    expect(html).toContain('50%');
    expect(html).not.toContain('No requests');
    const unassigned = summarizeTeamBuilderAssignments(players, teams, [], allRequests);
    expect(unassigned.stats.averageHappiness).toBe(0);
    expect(unassigned.stats.coachRequestsHonored).toBe(0);
  });

  it.each(['needs-review', 'unresolvable'] as const)('does not call %s requests absent or include them in the percentage', status => {
    const pending = { ...requests[0], playerId: 'p2', id: 'pending', status, resolvedTargetId: null };
    const result = summarizeTeamBuilderAssignments(players, teams, assignments.slice(0, 2), [requests[0], pending]);
    expect(result.stats.requestingPlayers).toBe(2);
    expect(result.stats.averageHappiness).toBe(1);
    expect(result.stats.coachRequestsTotal).toBe(1);
    const onlyPending = summarizeTeamBuilderAssignments(players, teams, [], [pending]);
    const html = renderToStaticMarkup(createElement(TeamBuilderResults, { result: onlyPending, players }));
    expect(html).not.toContain('No requests');
    expect(html).toContain('No confirmed requests');
    expect(html).not.toContain('100%');
    expect(onlyPending.stats.coachRequestsTotal).toBe(0);
  });

  it('recognizes raw requests even before they have resolution records', () => {
    const raw = [{ ...players[0], teammateRequests: ['Blake'], coachRequest: 'Pine' }];
    expect(summarizeTeamBuilderAssignments(raw, teams, [], []).stats.requestingPlayers).toBe(1);
  });

  it('shows no requests rather than a perfect happiness score for incomplete rosters', () => {
    const result = summarizeTeamBuilderAssignments(players, teams, assignments.slice(0, 1), []);
    const html = renderToStaticMarkup(createElement(TeamBuilderResults, { result, players }));
    expect(html).toContain('No requests');
    expect(html).not.toContain('100%');
  });

  it('requires explicit confirmation for unassigned players, but not complete or empty rosters', () => {
    const confirm = vi.fn().mockReturnValue(false);
    expect(confirmTeamBuilderFinalization(players, confirm)).toBe(false);
    expect(confirm).toHaveBeenCalledWith(expect.stringContaining('4 of 4 players are unassigned: Player 0'));
    confirm.mockReturnValue(true);
    expect(confirmTeamBuilderFinalization(players, confirm)).toBe(true);
    confirm.mockClear();
    expect(confirmTeamBuilderFinalization(players.map(p => ({ ...p, draftedByTeamId: 't0' })), confirm)).toBe(true);
    expect(confirmTeamBuilderFinalization([], confirm)).toBe(true);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('renders swapped placements, totals, averages, and recomputed happiness', () => {
    const before = summarizeTeamBuilderAssignments(players, teams, assignments, requests);
    expect(before.teamSummaries.map(t => t.averageScore)).toEqual([80.6, 55.6]);
    expect(before.playerHappiness[0].score).toBe('all');
    const swapped = assignments.map(a => ({ ...a, teamId: a.playerId === 'p0' ? 't1' : a.playerId === 'p2' ? 't0' : a.teamId }));
    const after = summarizeTeamBuilderAssignments(players, teams, swapped, requests);
    expect(after.teamSummaries.map(t => t.totalScore)).toEqual([136.2, 136.2]);
    expect(after.teamSummaries.map(t => t.averageScore)).toEqual([68.1, 68.1]);
    expect(after.assignments.find(a => a.playerId === 'p0')?.teamId).toBe('t1');
    expect(after.playerHappiness[0].score).toBe('none');
    expect(after.stats.coachRequestsHonored).toBe(0);
    expect(after.stats.averageHappiness).toBe(0);
    const html = renderToStaticMarkup(createElement(TeamBuilderResults, { result: after, players }));
    expect(html).toContain('68.1');
    expect(html).not.toContain('80.6');
    expect(html).not.toContain('55.6');
  });

  it('recomputes usable suggestions after moving a suggested player to a third team', () => {
    const roster = [8, 50, 74, 59, 31, 73, 45, 79, 24, 10, 41, 66].map((totalScore, i) => ({
      ...players[0], id: `p${i}`, totalScore,
    }));
    const threeTeams = [...teams, { ...teams[0], id: 't2' }];
    const picks = roster.map((p, i) => assignment(p.id, `t${i % 3}`));
    const before = summarizeTeamBuilderAssignments(roster, threeTeams, picks, []);
    expect(before.suggestedTrades.length).toBeGreaterThan(0);
    const swapped = picks.map(a => ({ ...a, teamId: a.playerId === 'p7' ? 't2' : a.playerId === 'p2' ? 't1' : a.teamId }));
    const after = summarizeTeamBuilderAssignments(roster, threeTeams, swapped, []);
    expect(after.suggestedTrades.length).toBeGreaterThan(0);
    const currentPlayers = roster.map(p => ({ ...p, draftedByTeamId: swapped.find(a => a.playerId === p.id)!.teamId }));
    expect(after.suggestedTrades.every(trade => isSuggestedTradeCurrent(trade, currentPlayers))).toBe(true);
  });

  it('handles empty results without stale totals or invalid averages', () => {
    const result = summarizeTeamBuilderAssignments([], teams, [], []);
    expect(result.teamSummaries.every(t => t.totalScore === 0 && t.averageScore === 0)).toBe(true);
    expect(result.playerHappiness).toEqual([]);
    expect(result.suggestedTrades).toEqual([]);
  });
});
