import { describe, expect, it } from 'vitest';
import { Team } from '../types';
import {
  DEFAULT_TEAM_BUILDER_CONFIG,
  runRequestsFirstAlgorithm,
  runTeamBuilderAlgorithm,
  TeamBuilderConfig,
  TeamBuilderPlayer,
} from './teamBuilderAlgorithm';

const makeTeams = (count = 5): Team[] => Array.from({ length: count }, (_, i) => ({
  id: `t${i + 1}`, teamName: i === 3 ? 'Pine' : '', headCoach: '', assistantCoach: '',
  draftPosition: i + 1, roster: [], totalScore: 0, coachKids: [], ageBreakdown: {},
}));
const makePlayers = (): TeamBuilderPlayer[] => [
  'One', 'Two', 'Avery', 'Blake', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten',
].map((name, i) => ({
  id: `p${i + 1}`, bib: String(i + 1), name, firstName: name, lastName: '',
  fieldScore: 0, throwScore: 0, hitPower: 0, hitForm: 0, hitContact: 0,
  pitchingStrength: 0, pitchingForm: 0, catchScore: 0, runningScore: 0,
  fieldingSubtotal: 0, hittingSubtotal: 0, pitchingSubtotal: 0,
  subjectiveTotal: 0, objectiveTotal: 0, officialAdjust: 0,
  totalScore: 100 - i * 10, rank: i + 1, projectedRound: 1, littleLeagueAge: 8,
  birthday: '', isAllStar: false, isDNE: false, isCoachKid: false, isDrafted: false,
  ...(i === 2 ? { siblingId: 'p4' } : i === 3 ? { siblingId: 'p3' } : {}),
}));

describe.each(['balance-first', 'requests-first'] as const)('%s confirmed siblings', mode => {
  const run = (players = makePlayers(), overrides: Partial<TeamBuilderConfig> = {}, teams = makeTeams()) => {
    const config = { ...DEFAULT_TEAM_BUILDER_CONFIG, minRosterSize: 2, ...overrides };
    return mode === 'balance-first'
      ? runTeamBuilderAlgorithm(players, teams, config)
      : runRequestsFirstAlgorithm(players, teams, [], config);
  };

  it('keeps the 10-player/5-team reproducer pair together with default two top-talent rounds', () => {
    const players = makePlayers();
    const original = structuredClone(players);
    const result = run(players);
    const siblings = result.assignments.filter(a => ['p3', 'p4'].includes(a.playerId));
    expect(siblings).toHaveLength(2);
    expect(new Set(siblings.map(a => a.teamId)).size).toBe(1);
    expect(result.assignments).toHaveLength(10);
    expect(new Set(result.assignments.map(a => a.playerId)).size).toBe(10);
    expect(result.teamSummaries.map(t => t.rosterCount)).toEqual([2, 2, 2, 2, 2]);
    expect(result.warnings).toEqual([]);
    expect(players).toEqual(original);
  });

  it('also keeps the pair together when top-talent distribution is disabled', () => {
    const result = run(makePlayers(), { topTalentRounds: 0 });
    expect(result.assignments.find(a => a.playerId === 'p3')?.teamId)
      .toBe(result.assignments.find(a => a.playerId === 'p4')?.teamId);
    expect(result.teamSummaries.map(t => t.rosterCount)).toEqual([2, 2, 2, 2, 2]);
  });

  it('places a connected three-sibling cycle atomically within even-roster caps', () => {
    const players = makePlayers().slice(0, 9);
    players[3].siblingId = 'p5';
    players[4].siblingId = 'p3';
    const result = run(players, { maxRosterSize: 3, forceEvenTeams: true }, makeTeams(3));
    expect(new Set(result.assignments.filter(a => ['p3', 'p4', 'p5'].includes(a.playerId)).map(a => a.teamId)).size).toBe(1);
    expect(result.assignments).toHaveLength(9);
    expect(result.teamSummaries.map(t => t.rosterCount)).toEqual([3, 3, 3]);
  });

  it('honors a coach anchor before placing its unassigned sibling', () => {
    const players = makePlayers();
    players[2].isCoachKid = true;
    players[2].coachTeamId = 't3';
    const result = run(players);
    expect(result.assignments.find(a => a.playerId === 'p3')).toMatchObject({ teamId: 't3', reason: 'coach-kid' });
    expect(result.assignments.find(a => a.playerId === 'p4')).toMatchObject({ teamId: 't3', reason: 'sibling-lock' });
    expect(result.teamSummaries.map(t => t.rosterCount)).toEqual([2, 2, 2, 2, 2]);
  });

  it('places a lower-scoring anchored group before an unpinned pair can consume its coach team’s seats', () => {
    const players = makePlayers().slice(0, 9);
    for (const [index, teamId] of [[0, 't2'], [1, 't3'], [6, 't1']] as const) {
      players[index].isCoachKid = true;
      players[index].coachTeamId = teamId;
    }
    players[6].siblingId = 'p8';
    players[7].siblingId = 'p7';
    const result = run(players, { maxRosterSize: 3 }, makeTeams(3));
    expect(result.assignments.find(a => a.playerId === 'p7')?.teamId).toBe('t1');
    expect(result.assignments.find(a => a.playerId === 'p8')?.teamId).toBe('t1');
    expect(result.assignments.find(a => a.playerId === 'p3')?.teamId)
      .toBe(result.assignments.find(a => a.playerId === 'p4')?.teamId);
    expect(result.assignments.find(a => a.playerId === 'p3')?.teamId).not.toBe('t1');
    expect(result.assignments).toHaveLength(9);
    expect(result.teamSummaries.map(t => t.rosterCount)).toEqual([3, 3, 3]);
    expect(result.warnings).toEqual([]);
  });

  it('preserves manual anchors and unrelated pinned players through minimum-roster repair', () => {
    const players = makePlayers();
    players[2].lockedToTeamId = 't4';
    players[0].lockedToTeamId = 't2';
    const result = run(players);
    expect(result.assignments.find(a => a.playerId === 'p3')).toMatchObject({ teamId: 't4', reason: 'manual-lock' });
    expect(result.assignments.find(a => a.playerId === 'p4')?.teamId).toBe('t4');
    expect(result.assignments.find(a => a.playerId === 'p1')?.teamId).toBe('t2');
    expect(result.teamSummaries.map(t => t.rosterCount)).toEqual([2, 2, 2, 2, 2]);
  });

  it.each([false, true])('warns and leaves oversized groups unassigned instead of splitting (even=%s)', forceEvenTeams => {
    const players = makePlayers();
    players[3].siblingId = 'p5';
    players[4].siblingId = 'p3';
    const result = run(players, { maxRosterSize: forceEvenTeams ? 13 : 2, forceEvenTeams });
    expect(result.assignments.filter(a => ['p3', 'p4', 'p5'].includes(a.playerId))).toEqual([]);
    expect(result.warnings.some(w => w.includes('Sibling group') && w.includes('Avery') && w.includes('unassigned'))).toBe(true);
    expect(result.teamSummaries.every(t => t.rosterCount <= 2)).toBe(true);
    expect(result.assignments).toHaveLength(7);
  });

  it('warns about conflicting coach/manual anchors without moving pinned players', () => {
    const players = makePlayers();
    players[2].isCoachKid = true;
    players[2].coachTeamId = 't1';
    players[3].lockedToTeamId = 't2';
    const result = run(players);
    expect(result.assignments.find(a => a.playerId === 'p3')?.teamId).toBe('t1');
    expect(result.assignments.find(a => a.playerId === 'p4')?.teamId).toBe('t2');
    expect(result.warnings.some(w => w.includes('Sibling group') && w.includes('Existing placements are unchanged'))).toBe(true);
  });

  it('does not send a sibling elsewhere when the coach anchor’s team is full', () => {
    const players = makePlayers();
    for (const index of [0, 2]) {
      players[index].isCoachKid = true;
      players[index].coachTeamId = 't1';
    }
    const result = run(players, { maxRosterSize: 2 });
    expect(result.assignments.find(a => a.playerId === 'p3')?.teamId).toBe('t1');
    expect(result.assignments.find(a => a.playerId === 'p4')).toBeUndefined();
    expect(result.warnings.some(w => w.includes('Sibling group') && w.includes('Blake'))).toBe(true);
    expect(result.teamSummaries.every(t => t.rosterCount <= 2)).toBe(true);
  });

  it('handles empty players without sibling warnings', () => {
    const result = run([]);
    expect(result.assignments).toEqual([]);
    expect(result.warnings.some(w => w.includes('Sibling group'))).toBe(false);
  });
});
