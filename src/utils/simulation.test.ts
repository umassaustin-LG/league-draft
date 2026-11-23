import { describe, expect, it } from 'vitest';
import { Player, Team } from '../types';
import { runSimulation } from './simulation';

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
  it('reserves room for a low-ranked sibling pair before every team reaches its last slot', () => {
    const players = [player('a', 100), player('b', 90), player('c', 80), player('d', 70),
      player('sib1', 20, 'sib2'), player('sib2', 10, 'sib1')];
    const result = runSimulation(players, teams, teams.map(t => t.id), 'straight', options);
    expect(result.players.every(p => p.isDrafted)).toBe(true);
    expect(result.players[4].draftedByTeamId).toBe(result.players[5].draftedByTeamId);
    expect(result.teams.map(t => t.roster.length)).toEqual([2, 2, 2]);
    expect(players.every(p => !p.isDrafted)).toBe(true);
  });

  it('reserves capacity for multiple sibling groups', () => {
    const players = [player('a', 100), player('b', 90), player('c', 40, 'd'), player('d', 30, 'c'),
      player('e', 20, 'f'), player('f', 10, 'e')];
    const result = runSimulation(players, teams, teams.map(t => t.id), 'snake', options);
    expect(result.players.every(p => p.isDrafted)).toBe(true);
    for (const [first, second] of [[2, 3], [4, 5]]) {
      expect(result.players[first].draftedByTeamId).toBe(result.players[second].draftedByTeamId);
    }
  });

  it('handles an empty roster and permits independent picks when siblings are disabled', () => {
    expect(runSimulation([], teams, teams.map(t => t.id), 'straight', options).players).toEqual([]);
    const players = [player('a', 20, 'b'), player('b', 10, 'a')];
    const result = runSimulation(players, teams.slice(0, 2), teams.slice(0, 2).map(t => t.id), 'straight', { ...options, includeSiblings: false });
    expect(result.players.every(p => p.isDrafted)).toBe(true);
  });
});
