import { describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DraftBoardRosterView } from '../components/draft/DraftBoardRosterView';
import { DraftBoardPlayerGrid } from '../components/draft/DraftBoardPlayerGrid';
import { DraftBoard } from '../components/DraftBoard';
import { DraftState, Player, Team } from '../types';
import { clearForeignCoachMandatoryPick, getBestAvailable, getMandatoryPick, lockSiblingToTeam, releaseExhaustedSiblingLocks } from './draftLogic';
import { getPickWarnings } from './draftSafety';
import { runSimulation } from './simulation';

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
const teams: Team[] = Array.from({ length: 5 }, (_, i) => ({
  id: `t${i + 1}`, draftPosition: i + 1, teamName: '', headCoach: '', assistantCoach: '',
  roster: [], totalScore: 0, coachKids: [], ageBreakdown: {},
}));
const family = () => [
  player('Cedar', { totalScore: 100, siblingId: 'Delta' }),
  player('Delta', { totalScore: 90, siblingId: 'Cedar', isCoachKid: true, coachTeamId: 't5' }),
];
const config = { enforceAgeLimit: false, maxPerAge: 0, ageRange: { min: 7, max: 10 }, rosterSize: 2, teamCount: 5, teams };

describe('coach assignment takes precedence over sibling locks', () => {
  it('does not turn another team’s reserved sibling into a legacy mandatory pick after a split', () => {
    const players = [player('Reserved', { siblingId: 'Released', sibling: 'Released', lockedToTeamId: 't1' }),
      player('Released', { siblingId: 'Reserved', isDrafted: true, draftedByTeamId: 't2' })];
    expect(getMandatoryPick(players, 't2', 2)).toBeNull();
    expect(getMandatoryPick(players, 't1', 2)?.player.id).toBe('Reserved');
    players[0].lockedToTeamId = undefined;
    expect(getMandatoryPick(players, 't2', 2)?.player.id).toBe('Reserved');
  });
  it('reserves the last seat for an own coach kid without counting its own lock twice', () => {
    const players = [player('child', { isCoachKid: true, coachTeamId: 't1', lockedToTeamId: 't1' }),
      player('sibling', { lockedToTeamId: 't1' })];
    const twoSeats = structuredClone(players);
    const disabled = structuredClone(players);
    releaseExhaustedSiblingLocks(players, { t1: 1 });
    expect(players[0].lockedToTeamId).toBe('t1');
    expect(players[1].lockedToTeamId).toBeUndefined();
    releaseExhaustedSiblingLocks(twoSeats, { t1: 2 });
    expect(twoSeats[1].lockedToTeamId).toBe('t1');
    disabled[0].lockedToTeamId = undefined;
    releaseExhaustedSiblingLocks(disabled, { t1: 1 }, false);
    expect(disabled[1].lockedToTeamId).toBe('t1');
  });
  it('removes foreign coach locks before trimming legitimate sibling capacity', () => {
    const players = [player('foreign', { isCoachKid: true, coachTeamId: 't5', lockedToTeamId: 't1', rank: 1 }),
      player('sibling', { lockedToTeamId: 't1', rank: 2 })];
    const disabled = structuredClone(players);
    releaseExhaustedSiblingLocks(players, { t1: 1, t5: 2 });
    expect(players[0].lockedToTeamId).toBeUndefined();
    expect(players[1].lockedToTeamId).toBe('t1');
    releaseExhaustedSiblingLocks(disabled, { t1: 1, t5: 2 }, false);
    expect(disabled[0].lockedToTeamId).toBe('t1');
    expect(disabled[1].lockedToTeamId).toBeUndefined();
  });
  it('clears a resumed foreign coach mandatory pick in hook state and on the board', () => {
    const state: DraftState = {
      players: family(), teams, draftFormat: 'straight', draftOrder: teams.map(t => t.id),
      currentRoundOrder: teams.map(t => t.id), picks: [], currentRound: 1, currentPickInRound: 1,
      currentTeamId: 't1', isDraftComplete: false, trades: [],
      mandatoryPick: { playerId: 'Delta', reason: 'sibling', siblingName: 'Cedar' },
    };
    expect(clearForeignCoachMandatoryPick(state).mandatoryPick).toBeUndefined();
    expect(clearForeignCoachMandatoryPick({ ...state, currentTeamId: 't5' }).mandatoryPick).toEqual(state.mandatoryPick);
    expect(clearForeignCoachMandatoryPick({ ...state, mandatoryPick: undefined }).mandatoryPick).toBeUndefined();
    const html = renderToStaticMarkup(createElement(DraftBoard, {
      draftState: state, enforceAgeLimit: false, maxPerAge: 0, rosterSize: 2,
      controls: { onDraftPlayer: () => {}, onSkipPick: () => {}, onUndo: () => {}, onReset: () => {},
        pendingComplete: false, onFinalizeDraft: () => {}, onCancelComplete: () => {} },
    }));
    expect(html).not.toContain('Sibling of Cedar');
    expect(html).toMatch(/<button[^>]*>Draft<\/button>/);
  });
  it.each(['forward', 'reverse'] as const)('does not lock another team’s coach kid through a %s link', direction => {
    const players = family();
    if (direction === 'forward') players[1].siblingId = undefined;
    else players[0].siblingId = undefined;
    players[0].isDrafted = true;
    players[0].draftedByTeamId = 't1';
    lockSiblingToTeam(players, players[0], 't1');
    expect(players[1].lockedToTeamId).toBeUndefined();
    expect(players[1].coachTeamId).toBe('t5');
    expect(getMandatoryPick(players, 't1', 2, { includeCoachKids: true, includeSiblings: true, totalRounds: 2, teamPicksMade: 1 })).toBeNull();
    expect(getMandatoryPick(players, 't5', 2)?.player.id).toBe('Delta');
  });

  it('ignores a stale contradictory lock for immediate and forced mandatory picks', () => {
    const players = family();
    players[0].isDrafted = true;
    players[1].lockedToTeamId = 't1';
    expect(getMandatoryPick(players, 't1', 2)).toBeNull();
    expect(getMandatoryPick(players, 't1', 1, { includeCoachKids: true, includeSiblings: true, totalRounds: 2, teamPicksMade: 1 })).toBeNull();
    expect(getBestAvailable(players, 't5')?.id).toBe('Delta');
    expect(getBestAvailable(players, 't1')).toBeNull();
  });

  it('requires override before splitting a coach’s family, even for a mandatory sibling', () => {
    const players = family();
    const expected = {
      code: 'sibling_coach_conflict', level: 'block',
      message: "Cedar's sibling Delta is Team 5's coach kid — drafting splits them; Team 5 should take Cedar",
    };
    expect(getPickWarnings(players[0], teams[0], players, [], config)).toContainEqual(expected);
    expect(getPickWarnings(players[0], teams[0], players, [], config, 'Cedar')).toContainEqual(expected);
    expect(getPickWarnings(players[0], teams[4], players, [], config).some(w => w.code === expected.code)).toBe(false);
    expect(getPickWarnings(players[0], teams[0], players, [], config).some(w => w.code === 'sibling_lock')).toBe(false);
  });

  it('pre-fills Delta only for the coach team despite a stale Team 1 lock', () => {
    const delta = { ...family()[1], lockedToTeamId: 't1' };
    const html = renderToStaticMarkup(createElement(DraftBoardRosterView, {
      players: [delta], teams, draftOrder: teams.map(t => t.id), currentRound: 1,
      currentPickInRound: 1, currentRoundOrder: teams.map(t => t.id),
      showScores: false, totalRounds: 2, isPublicView: false,
    }));
    const row = html.match(/<tr[^>]*>[\s\S]*?<\/tr>/g)![2];
    const cells = row.match(/<td[^>]*>[\s\S]*?<\/td>/g)!;
    expect(cells[1]).not.toContain('Delta');
    expect(cells[5]).toContain('Delta');
    expect(html.match(/>Delta</g)).toHaveLength(1);
  });

  it('keeps a stale-locked coach kid draftable by the coach team in the grid', () => {
    const html = renderToStaticMarkup(createElement(DraftBoardPlayerGrid, {
      players: [{ ...family()[1], lockedToTeamId: 't1' }], teams,
      currentTeamId: 't5', showScores: false, enforceAgeLimit: false,
      maxPerAge: 0, currentTeamAgeBreakdown: {}, onDraftPlayer: () => {}, isLoading: false, isReadOnly: false,
    }));
    expect(html).toMatch(/<button[^>]*>Draft<\/button>/);
  });

  it.each(['straight', 'snake', 'recalculated'] as const)('simulates Cedar and Delta on Team 5 when space permits (%s)', format => {
    const players = [...family(), ...Array.from({ length: 8 }, (_, i) => player(`Single ${i}`, { totalScore: 80 - i }))];
    const result = runSimulation(players, teams, teams.map(t => t.id), format, { includeCoachKids: true, includeSiblings: true });
    expect(result.players[0].draftedByTeamId).toBe('t5');
    expect(result.players[1].draftedByTeamId).toBe('t5');
    expect(result.players.every(p => p.isDrafted)).toBe(true);
    expect(players.every(p => !p.isDrafted && !p.lockedToTeamId)).toBe(true);
  });

  it('does not move coach kids when siblings have conflicting coach assignments', () => {
    const players = family();
    players[0].isCoachKid = true;
    players[0].coachTeamId = 't1';
    players.push(...Array.from({ length: 8 }, (_, i) => player(`Single ${i}`)));
    const result = runSimulation(players, teams, teams.map(t => t.id), 'straight', { includeCoachKids: true, includeSiblings: true });
    expect(result.players[0].draftedByTeamId).toBe('t1');
    expect(result.players[1].draftedByTeamId).toBe('t5');
    expect(result.players.every(p => p.isDrafted)).toBe(true);
  });

  it('keeps ordinary sibling locks, disabled rules and empty simulations working', () => {
    const players = [player('one', { siblingId: 'two', isDrafted: true }), player('two')];
    lockSiblingToTeam(players, players[0], 't1');
    expect(players[1].lockedToTeamId).toBe('t1');
    const ignored = family();
    lockSiblingToTeam(ignored, ignored[0], 't1', false);
    expect(ignored[1].lockedToTeamId).toBe('t1');
    expect(runSimulation([], teams, teams.map(t => t.id), 'straight', { includeCoachKids: true, includeSiblings: true }).players).toEqual([]);
  });

  it('preserves the third sibling’s original lock after an approved split', () => {
    const players = [...family(), player('Echo', { siblingId: 'Delta', lockedToTeamId: 't1' })];
    players[0].isDrafted = true;
    players[0].draftedByTeamId = 't1';
    players[1].isDrafted = true;
    lockSiblingToTeam(players, players[1], 't5');
    expect(players[2].lockedToTeamId).toBe('t1');
  });

  it('simulation does not steal the original team’s reserved sibling when drafting the coach kid', () => {
    const players = [...family(), player('Echo', { siblingId: 'Delta' }),
      ...Array.from({ length: 7 }, (_, i) => player(`Single ${i}`, { totalScore: 80 - i }))];
    players[1].projectedRound = 1;
    const result = runSimulation(players, teams, teams.map(t => t.id), 'straight', { includeCoachKids: true, includeSiblings: true });
    expect(result.players[0].draftedByTeamId).toBe('t1');
    expect(result.players[1].draftedByTeamId).toBe('t5');
    expect(result.players[2].draftedByTeamId).toBe('t1');
  });
});
