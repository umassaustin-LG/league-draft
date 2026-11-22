import { describe, expect, it } from 'vitest';
import { Player, Team } from '../types';
import { DraftSafetyConfig, getPickWarnings } from './draftSafety';

const player = (id: string, overrides: Partial<Player> = {}): Player => ({
  id, bib: id, name: id, firstName: id, lastName: '',
  fieldScore: 0, throwScore: 0, hitPower: 0, hitForm: 0, hitContact: 0,
  pitchingStrength: 0, pitchingForm: 0, catchScore: 0, runningScore: 0,
  fieldingSubtotal: 0, hittingSubtotal: 0, pitchingSubtotal: 0,
  subjectiveTotal: 0, objectiveTotal: 0, officialAdjust: 0,
  totalScore: 10, rank: 1, projectedRound: 2, littleLeagueAge: 9,
  birthday: '', isAllStar: false, isDNE: false, isCoachKid: false, isDrafted: false,
  ...overrides,
});
const team: Team = {
  id: 'team', teamName: '', headCoach: '', assistantCoach: '', draftPosition: 1,
  roster: [], totalScore: 0, coachKids: [], ageBreakdown: {},
};
const config: DraftSafetyConfig = {
  enforceAgeLimit: true, maxPerAge: 2, ageRange: { min: 8, max: 10 }, rosterSize: 3, teamCount: 2,
};

describe('getPickWarnings', () => {
  it('returns no warnings for an ordinary pick and empty history', () => {
    const p = player('pick');
    expect(getPickWarnings(p, team, [p], [], config)).toEqual([]);
  });

  it('warns when reaching the age cap and blocks when already at it', () => {
    const p = player('pick');
    const drafted = player('drafted', { isDrafted: true, draftedByTeamId: team.id });
    expect(getPickWarnings(p, team, [p, drafted], [], config)).toContainEqual({
      code: 'age_cap', level: 'warn', message: 'This pick reaches the age 9 cap',
    });
    expect(getPickWarnings(p, team, [p, drafted], [], { ...config, maxPerAge: 1 })[0]).toEqual({
      code: 'age_cap', level: 'block', message: 'Team 1 already has the maximum players of age 9',
    });
    expect(getPickWarnings(p, team, [p, drafted], [], { ...config, enforceAgeLimit: false })).toEqual([]);
  });

  it('warns for out-of-range ages', () => {
    const p = player('older', { littleLeagueAge: 12 });
    expect(getPickWarnings(p, team, [p], [], config)[0].code).toBe('age_range');
  });

  it('walks forward/reverse sibling chains, warns of locks, and blocks insufficient capacity', () => {
    const p = player('pick', { siblingId: 'sibling' });
    const sibling = player('sibling', { lockedToRound: 3 });
    const third = player('third', { siblingId: sibling.id });
    const players = [p, sibling, third];
    const warnings = getPickWarnings(p, team, players, [], { ...config, rosterSize: 2 });
    expect(warnings.map(w => w.code)).toEqual(['sibling_capacity', 'sibling_lock', 'sibling_lock']);
    expect(warnings[1].message).toBe('Drafting pick locks sibling sibling to Team 1 in round 3');
    expect(getPickWarnings(p, team, players, [], config).every(w => w.level === 'warn')).toBe(true);
    expect(players.some(p => p.lockedToTeamId)).toBe(false);
  });

  it('counts skipped picks and deduplicates already owed coach kids', () => {
    const p = player('pick', { siblingId: 'sibling' });
    const sibling = player('sibling', { isCoachKid: true, coachTeamId: team.id });
    const picks = [{ round: 1, pick: 1, teamId: team.id, wasSkipped: true }];
    expect(getPickWarnings(p, team, [p, sibling], picks, config).some(w => w.level === 'block')).toBe(false);
    expect(getPickWarnings(p, team, [p, sibling], picks, { ...config, rosterSize: 2 })[0].level).toBe('block');
  });

  it('does not warn of new locks for drafted or already locked siblings', () => {
    const p = player('pick', { siblingId: 'sibling' });
    const sibling = player('sibling', { lockedToTeamId: team.id });
    expect(getPickWarnings(p, team, [p, sibling], [], config)).toEqual([]);
  });

  it('warns for roster imbalance only after the minimum sample', () => {
    const p = player('pick', { totalScore: 100 });
    const drafted = player('drafted', { totalScore: 100, isDrafted: true, draftedByTeamId: team.id, littleLeagueAge: 8 });
    const other = player('other', { totalScore: 0, isDrafted: true, draftedByTeamId: 'other' });
    expect(getPickWarnings(p, team, [p, drafted, other], [], config).some(w => w.code === 'roster_balance')).toBe(true);
    expect(getPickWarnings(p, team, [p, other], [], config)).toEqual([]);
    expect(getPickWarnings(p, team, [p, drafted, other], [], { ...config, teamCount: 4 })).toEqual([]);
  });

  it('downgrades all blocks for mandatory players and uses coach display fallback', () => {
    const p = player('pick', { siblingId: 'sibling' });
    const drafted = player('drafted', { isDrafted: true, draftedByTeamId: team.id });
    const sibling = player('sibling');
    const warnings = getPickWarnings(p, { ...team, headCoach: 'Coach' }, [p, drafted, sibling], [], { ...config, maxPerAge: 1, rosterSize: 1 }, p.id);
    expect(warnings.every(w => w.level === 'warn')).toBe(true);
    expect(warnings[0].message).toContain('Coach');
  });
});
