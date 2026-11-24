import { describe, expect, it } from 'vitest';
import { Player, ResolvedRequest, Team } from '../types';
import {
  DEFAULT_TEAM_BUILDER_CONFIG,
  runRequestsFirstAlgorithm,
  runTeamBuilderAlgorithm,
  TeamBuilderPlayer,
} from './teamBuilderAlgorithm';

const player = (index: number, overrides: Partial<Player> = {}): TeamBuilderPlayer => ({
  id: `p${index}`, bib: String(index), name: `Player ${index}`, firstName: 'Player', lastName: String(index),
  fieldScore: 0, throwScore: 0, hitPower: 0, hitForm: 0, hitContact: 0,
  pitchingStrength: 0, pitchingForm: 0, catchScore: 0, runningScore: 0,
  fieldingSubtotal: 0, hittingSubtotal: 0, pitchingSubtotal: 0,
  subjectiveTotal: 0, objectiveTotal: 0, officialAdjust: 0,
  totalScore: 10, rank: index + 1, projectedRound: 1, littleLeagueAge: 8,
  birthday: '', isAllStar: false, isDNE: false, isCoachKid: false, isDrafted: false,
  ...overrides,
});
const teams: Team[] = Array.from({ length: 5 }, (_, index) => ({
  id: `t${index}`, teamName: '', headCoach: index < 2 ? `Coach ${index}` : '',
  assistantCoach: '', draftPosition: index + 1, roster: [], totalScore: 0,
  coachKids: [], ageBreakdown: {},
}));
const config = { ...DEFAULT_TEAM_BUILDER_CONFIG, topTalentRounds: 0, minRosterSize: 2, maxRosterSize: 5 };
const request = (p: Player): ResolvedRequest => ({
  id: p.id, playerId: p.id, requestType: 'coach', rawRequestString: 'Coach 0',
  resolvedTargetId: 't0', resolvedTargetName: 'Coach 0', status: 'user-confirmed',
  confidenceScore: 1, isTwoWay: false,
});

describe.each(['requests-first', 'balance-first'] as const)('%s roster constraints', mode => {
  const run = (players: TeamBuilderPlayer[], overrides = {}) => mode === 'requests-first'
    ? runRequestsFirstAlgorithm(players, teams, players.map(request), { ...config, ...overrides })
    : runTeamBuilderAlgorithm(players.map(p => ({ ...p, resolvedCoachTeamId: 't0' })), teams, { ...config, ...overrides });

  it('fills five teams to the feasible minimum despite all requests favoring one coach', () => {
    const players = Array.from({ length: 10 }, (_, i) => player(i));
    const result = run(players);
    expect(result.teamSummaries.map(team => team.rosterCount)).toEqual([2, 2, 2, 2, 2]);
    expect(new Set(result.assignments.map(a => a.playerId)).size).toBe(10);
    expect(result.teamSummaries.map(team => team.teamName)).toEqual(['Coach 0', 'Coach 1', 'Team 3', 'Team 4', 'Team 5']);
    expect(result.warnings).toEqual([]);
    expect(players.every(p => !p.draftedByTeamId)).toBe(true);
  });

  it('fills every team with zero-score players even when the configured minimum is zero', () => {
    const result = run(Array.from({ length: 10 }, (_, i) => player(i, { totalScore: 0 })), { minRosterSize: 0 });
    expect(result.teamSummaries.every(team => team.rosterCount > 0)).toBe(true);
    expect(result.assignments).toHaveLength(10);
  });

  it('fills as many teams as possible and reports insufficient players', () => {
    const result = run([player(0), player(1), player(2)]);
    expect(result.teamSummaries.filter(team => team.rosterCount > 0)).toHaveLength(3);
    expect(result.warnings.some(warning => warning.includes('below the minimum'))).toBe(true);
  });

  it('does not move coach kids or manual locks to hide an infeasible minimum', () => {
    const players = Array.from({ length: 10 }, (_, i) => player(i, i < 5
      ? { isCoachKid: true, coachTeamId: 't0' }
      : { lockedToTeamId: 't1' }));
    const result = run(players);
    expect(result.assignments.filter(a => a.teamId === 't0')).toHaveLength(5);
    expect(result.assignments.filter(a => a.teamId === 't1')).toHaveLength(5);
    expect(result.warnings.some(warning => warning.includes('below the minimum'))).toBe(true);
    expect(result.teamSummaries.every(team => team.rosterCount <= 5)).toBe(true);
  });

  it('returns named empty rosters and warnings for an empty import', () => {
    const result = run([]);
    expect(result.assignments).toEqual([]);
    expect(result.teamSummaries.every(team => team.rosterCount === 0 && team.teamName)).toBe(true);
    expect(result.warnings).toHaveLength(5);
  });

  it('respects the maximum when there is not enough total capacity', () => {
    const result = run(Array.from({ length: 12 }, (_, i) => player(i)), { maxRosterSize: 2 });
    expect(result.teamSummaries.every(team => team.rosterCount <= 2)).toBe(true);
    expect(result.assignments).toHaveLength(10);
    expect(result.warnings.length).toBeGreaterThan(0);
  });
});
