import { describe, expect, it } from 'vitest';
import { Player, Team } from '../types';
import { runSimulation } from './simulation';
import { getBestAvailable } from './draftLogic';

const player = (id: string, score: number, siblingId?: string): Player => ({
  id, name: id, totalScore: score, projectedRound: 2, littleLeagueAge: 8,
  isDrafted: false, isCoachKid: false, siblingId,
} as Player);
const teams: Team[] = [0, 1, 2].map(i => ({
  id: `t${i}`, draftPosition: i + 1, roster: [], totalScore: 0, ageBreakdown: {},
  teamName: '', headCoach: '', assistantCoach: '', coachKids: [],
}));
const options = { includeCoachKids: true, includeSiblings: true };

describe('simulation sibling capacity', () => {
  it('does not start a low-ranked sibling pair when only last slots remain', () => {
    const players = [player('a', 100), player('b', 90), player('c', 80), player('d', 70),
      player('sib1', 20, 'sib2'), player('sib2', 10, 'sib1')];
    const result = runSimulation(players, teams, teams.map(t => t.id), 'straight', options);
    expect(result.players.slice(0, 4).every(p => p.isDrafted)).toBe(true);
    expect(result.players.slice(4).every(p => !p.isDrafted)).toBe(true);
    expect(players.every(p => !p.isDrafted)).toBe(true);
  });

  it('reserves capacity for multiple sibling groups', () => {
    const players = [player('a', 20), player('b', 10), player('c', 100, 'd'), player('d', 30, 'c'),
      player('e', 90, 'f'), player('f', 40, 'e')];
    const result = runSimulation(players, teams, teams.map(t => t.id), 'snake', options);
    expect(result.players.every(p => p.isDrafted)).toBe(true);
    for (const [first, second] of [[2, 3], [4, 5]]) {
      expect(result.players[first].draftedByTeamId).toBe(result.players[second].draftedByTeamId);
    }
  });

  it('keeps unrelated turns available when sibling coach kids belong to different teams', () => {
    const players = [player('a', 100), player('b', 90),
      { ...player('c', 80, 'd'), isCoachKid: true, coachTeamId: 't0' },
      { ...player('d', 70, 'c'), isCoachKid: true, coachTeamId: 't1' }];
    const result = runSimulation(players, teams.slice(0, 2), ['t0', 't1'], 'straight', options);
    expect(result.players.every(p => p.isDrafted)).toBe(true);
    expect(result.players.slice(0, 2).map(p => p.draftedInRound)).toEqual([1, 1]);
    expect(result.players.slice(2).map(p => p.draftedByTeamId)).toEqual(['t0', 't1']);
  });

  it('checks capacity in score order and stops once the highest eligible scorer fits', () => {
    const checked: string[] = [];
    const result = getBestAvailable([player('low', 10), player('high', 100)], 't0', options, p => {
      checked.push(p.id);
      return true;
    });
    expect(result?.id).toBe('high');
    expect(checked).toEqual(['high']);
  });

  it('handles an empty roster and permits independent picks when siblings are disabled', () => {
    expect(runSimulation([], teams, teams.map(t => t.id), 'straight', options).players).toEqual([]);
    const players = [player('a', 20, 'b'), player('b', 10, 'a')];
    const result = runSimulation(players, teams.slice(0, 2), teams.slice(0, 2).map(t => t.id), 'straight', { ...options, includeSiblings: false });
    expect(result.players.every(p => p.isDrafted)).toBe(true);
  });
});
