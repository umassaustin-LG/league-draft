import { describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { DraftBoard } from '../components/DraftBoard';
import { DraftComplete } from '../components/DraftComplete';
import { DraftState, Player, Team } from '../types';
import { canSkipDraftPick, getBestAvailable, getDraftSiblingState, getMandatoryPick, lockSiblingToTeam, releaseExhaustedSiblingLocks } from './draftLogic';
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
const team = (id: string, draftPosition: number): Team => ({
  id, draftPosition, teamName: '', headCoach: '', assistantCoach: '',
  roster: [], totalScore: 0, coachKids: [], ageBreakdown: {},
});
const finalPickState = (): DraftState => ({
  players: [
    player('one', { isDrafted: true, draftedByTeamId: 'a' }),
    player('two', { isDrafted: true, draftedByTeamId: 'b' }),
    player('first-sibling', { siblingId: 'last-sibling', isDrafted: true, draftedByTeamId: 'a' }),
    player('last-sibling', { siblingId: 'first-sibling', lockedToTeamId: 'a' }),
  ],
  teams: [team('a', 1), team('b', 2)],
  draftFormat: 'straight', draftOrder: ['a', 'b'], currentRoundOrder: ['a', 'b'],
  picks: [
    { round: 1, pick: 1, teamId: 'a', playerId: 'one' },
    { round: 1, pick: 2, teamId: 'b', playerId: 'two' },
    { round: 2, pick: 3, teamId: 'a', playerId: 'first-sibling' },
  ],
  currentRound: 2, currentPickInRound: 2, currentTeamId: 'b', isDraftComplete: false, trades: [],
});
const controls = {
  onDraftPlayer: vi.fn(), onSkipPick: vi.fn(), onUndo: vi.fn(), onReset: vi.fn(),
  pendingComplete: false, onFinalizeDraft: vi.fn(), onCancelComplete: vi.fn(),
};
const renderBoard = (state: DraftState, rosterSize = 2) => renderToStaticMarkup(
  createElement(DraftBoard, { draftState: state, controls, rosterSize, enforceAgeLimit: false, maxPerAge: 0, onBackToDivisions: vi.fn() }),
);

describe('live last-slot sibling recovery', () => {
  it('keeps long undrafted lists scrollable separately from the completion actions', () => {
    const state = finalPickState();
    state.isDraftComplete = true;
    state.currentTeamId = null;
    state.players = Array.from({ length: 80 }, (_, i) => player(`Undrafted ${i}`));
    const markup = renderToStaticMarkup(createElement(DraftBoard, {
      draftState: state, controls: { ...controls, pendingComplete: true },
      rosterSize: 2, enforceAgeLimit: false, maxPerAge: 0,
    }));
    expect(markup).toContain('px-6 py-6 min-h-0 overflow-y-auto');
    expect(markup).toContain('<ul class="max-h-40 overflow-y-auto"><li>Undrafted 0</li>');
    expect(markup).toContain('<li>Undrafted 79</li></ul>');
    expect(markup).toMatch(/class="[^"]*shrink-0"[^>]*><button[^>]*>Back to review<\/button><button[^>]*>Finalize draft<\/button>/);
  });

  it.each(['skipped', 'all-drafted', 'empty'])('shows actual drafted counts and undrafted names on completion: %s', scenario => {
    const state = finalPickState();
    state.isDraftComplete = true;
    state.currentTeamId = null;
    state.picks.push({ round: 2, pick: 4, teamId: 'b', playerId: 'SKIPPED' });
    if (scenario === 'all-drafted') state.players = state.players.map(p => ({ ...p, isDrafted: true }));
    if (scenario === 'empty') state.players = [];
    const expected = scenario === 'skipped' ? '3/4' : scenario === 'all-drafted' ? '4/4' : '0/0';
    const surfaces = [
      createElement(DraftComplete, { draftState: state, onReset: vi.fn() }),
      createElement(DraftBoard, { draftState: state, controls: { ...controls, pendingComplete: true },
        rosterSize: 2, enforceAgeLimit: false, maxPerAge: 0 }),
    ];
    for (const surface of surfaces) {
      const markup = renderToStaticMarkup(surface).replace(/<!--.*?-->/g, '');
      expect(markup).toContain(`${expected} players have been drafted`);
      expect(markup).not.toContain('All 4 players have been drafted');
      if (scenario === 'skipped') {
        expect(markup).toContain('Undrafted players (1)');
        expect(markup).toContain('<li>last-sibling</li>');
      } else {
        expect(markup).not.toContain('Undrafted players');
      }
    }
  });

  it('offers non-destructive navigation on a completed board and preserves completion when viewing it', () => {
    const state = finalPickState();
    expect(renderBoard(state)).not.toContain('Back to Divisions');
    state.isDraftComplete = true;
    expect(renderBoard(state)).toContain('Back to Divisions');
    const markup = renderToStaticMarkup(createElement(DraftBoard, {
      draftState: state, controls, onViewResults: vi.fn(),
      rosterSize: 2, enforceAgeLimit: false, maxPerAge: 0,
    }));
    expect(markup).toContain('View Results');
    expect(state.picks).toHaveLength(3);
  });

  it('waits for explicit finalization before persisting the completed phase', () => {
    const state = finalPickState();
    state.isDraftComplete = true;
    const markup = renderToStaticMarkup(createElement(DraftBoard, {
      draftState: state, controls: { ...controls, pendingComplete: true },
      rosterSize: 2, enforceAgeLimit: false, maxPerAge: 0,
    }));
    expect(markup).toContain('Finalize draft');
    expect(markup).toContain('Back to review');
  });

  it.each([true, false])('shows View Results for a finalized draft regardless of unfilled slots (all slots filled: %s)', isDraftComplete => {
    const state = finalPickState();
    state.isDraftComplete = isDraftComplete;
    const markup = renderToStaticMarkup(createElement(DraftBoard, {
      draftState: state, controls: { ...controls, onRequestComplete: vi.fn() }, onViewResults: vi.fn(),
      onBackToDivisions: vi.fn(), rosterSize: 2, enforceAgeLimit: false, maxPerAge: 0,
    }));
    expect(markup).toContain('View Results');
    expect(markup).toContain('Back to Divisions');
    expect(markup).not.toContain('Finalize draft');
  });

  it('keeps Finalize accessible after dismissing the completion confirmation', () => {
    const state = finalPickState();
    const render = () => renderToStaticMarkup(createElement(DraftBoard, {
      draftState: state, controls: { ...controls, onRequestComplete: vi.fn() },
      rosterSize: 2, enforceAgeLimit: false, maxPerAge: 0,
    }));
    expect(render()).not.toContain('Finalize draft');
    state.isDraftComplete = true;
    expect(render()).toContain('Finalize draft');
    state.isDraftComplete = false;
    state.players = state.players.map(player => ({ ...player, isDrafted: true }));
    expect(render()).toContain('Finalize draft');
  });

  it('disables reopening finalization while a draft request is saving', () => {
    const state = { ...finalPickState(), isDraftComplete: true };
    const markup = renderToStaticMarkup(createElement(DraftBoard, {
      draftState: state, controls: { ...controls, onRequestComplete: vi.fn() }, isLoading: true,
      rosterSize: 2, enforceAgeLimit: false, maxPerAge: 0,
    }));
    expect(markup).toMatch(/<button[^>]*disabled=""[^>]*>\s*Finalize draft\s*<\/button>/);
  });

  it.each([
    ['Cedar', 'Sibling of Cedar'],
    [undefined, 'Linked sibling'],
    ['', 'Linked sibling'],
  ])('renders a mandatory sibling explanation for name %s', (siblingName, explanation) => {
    const state = finalPickState();
    state.currentTeamId = 'a';
    state.picks = state.picks.slice(0, 2);
    state.mandatoryPick = { playerId: 'last-sibling', reason: 'sibling', siblingName };
    const markup = renderBoard(state);
    expect(markup).toContain(explanation);
    expect(markup).not.toContain('Sibling of undefined');
  });

  it('does not transfer a retained sibling lock after another team drafts the released sibling', () => {
    const players = [
      player('root', { siblingId: 'kept', isDrafted: true, draftedByTeamId: 'a' }),
      player('kept', { siblingId: 'released', lockedToTeamId: 'a' }),
      player('released', { siblingId: 'root', isDrafted: true, draftedByTeamId: 'b' }),
    ];
    lockSiblingToTeam(players, players[2], 'b');
    releaseExhaustedSiblingLocks(players, { a: 1, b: 1 });
    expect(players[1].lockedToTeamId).toBe('a');
    expect(getMandatoryPick(players, 'a', 2)?.player.id).toBe('kept');
    expect(getBestAvailable(players, 'b')).toBeNull();
  });
  it('releases excess locks immediately, keeps one commitment, and explains backend releases', () => {
    const state = finalPickState();
    state.players = [
      player('root', { isDrafted: true, draftedByTeamId: 'a', siblingId: 'kept' }),
      player('kept', { siblingId: 'excess', lockedToTeamId: 'a', rank: 1 }),
      player('excess', { siblingId: 'root', lockedToTeamId: 'a', rank: 2 }), player('single'),
    ];
    state.picks = [{ round: 1, pick: 1, teamId: 'a', playerId: 'root' }];
    state.currentRound = 1;
    const recovered = getDraftSiblingState(state, 2);
    expect(recovered.players[1].lockedToTeamId).toBe('a');
    expect(recovered.players[2].lockedToTeamId).toBeUndefined();
    expect(recovered.released.map(player => player.id)).toEqual(['excess']);
    expect(canSkipDraftPick(recovered.players, 'b', 3)).toBe(false);
    state.players[2].lockedToTeamId = undefined;
    expect(renderBoard(state)).toContain('Sibling rule could not be honored for excess');
    expect(renderBoard(state)).toContain('does not have enough picks left');
  });
  it('releases an exhausted lock without changing saved input or coach assignment', () => {
    const saved = finalPickState();
    saved.players[3].isCoachKid = true;
    saved.players[3].coachTeamId = 'b';
    const { players, released } = getDraftSiblingState(saved, 2);
    expect(players[3].lockedToTeamId).toBeUndefined();
    expect(players[3].coachTeamId).toBe('b');
    expect(saved.players[3].lockedToTeamId).toBe('a');
    expect(released.map(p => p.id)).toEqual(['last-sibling']);
    expect(getBestAvailable(players, 'b')?.id).toBe('last-sibling');
    expect(getBestAvailable(players, 'a')).toBeNull();
  });

  it('keeps a sibling lock and mandatory pick while the team has space', () => {
    const players = [player('first', { isDrafted: true }), player('second', { siblingId: 'first' })];
    lockSiblingToTeam(players, players[0], 'a');
    releaseExhaustedSiblingLocks(players, { a: 1, b: 1 });
    expect(getBestAvailable(players, 'b')).toBeNull();
    expect(getMandatoryPick(players, 'a', 2)?.player.id).toBe('second');
  });

  it('renders a Draft button and visible release note at the formerly stuck final pick', () => {
    const html = renderBoard(finalPickState());
    expect(html).toContain('Sibling rule could not be honored for last-sibling');
    expect(html).toMatch(/<button[^>]*>Draft<\/button>/);
    expect(html).not.toContain('Locked to Team 1');
  });

  it('renders a restored lock from the undo API response without releasing it again', () => {
    const restored = finalPickState();
    restored.players[0].siblingId = 'last-sibling';
    restored.players[3].siblingId = 'one';
    restored.players[2].isDrafted = false;
    restored.players[2].draftedByTeamId = undefined;
    restored.players[2].siblingId = undefined;
    restored.picks.pop();
    restored.currentTeamId = 'a';
    restored.currentPickInRound = 1;
    const { players, released } = getDraftSiblingState(restored, 2);
    expect(players[3].lockedToTeamId).toBe('a');
    expect(getBestAvailable([players[3]], 'b')).toBeNull();
    expect(released).toEqual([]);
    expect(renderBoard(restored)).not.toContain('Sibling rule could not be honored');
  });

  it('allows emergency skip before the final round when only another coach’s kid remains', () => {
    const state = finalPickState();
    state.players[3].isCoachKid = true;
    state.players[3].coachTeamId = 'a';
    state.currentRound = 1;
    const html = renderBoard(state, 3);
    const skipButton = html.match(/<button[^>]*title="Skip this team&#x27;s pick"[^>]*>/)?.[0];
    expect(skipButton).toBeDefined();
    expect(skipButton).not.toContain(' disabled=');
    expect(html).not.toMatch(/<button[^>]*>Draft<\/button>/);
  });

  it('does not permit skipping a full draft when a player is draftable; handles empty pools', () => {
    expect(canSkipDraftPick([player('single')], 'a', 1)).toBe(false);
    expect(canSkipDraftPick([], 'a', 1)).toBe(true);
    expect(getDraftSiblingState({ ...finalPickState(), players: [], picks: [] }, 2).released).toEqual([]);
  });

  it('allows skipping an impossible mandatory pick but not a draftable coach kid', () => {
    const players = [player('mandatory', { isCoachKid: true, coachTeamId: 'b' }), player('ordinary')];
    expect(canSkipDraftPick(players, 'a', 2, 'mandatory')).toBe(true);
    expect(canSkipDraftPick(players, 'b', 3, 'mandatory')).toBe(false);
  });
});

describe('simulation last-slot siblings', () => {
  const options = { includeCoachKids: true, includeSiblings: true };

  it.each(['straight', 'snake', 'recalculated'] as const)('assigns all 10 players across 5 teams (%s)', format => {
    const teams = Array.from({ length: 5 }, (_, i) => team(`t${i}`, i + 1));
    const players = Array.from({ length: 10 }, (_, i) => player(`p${i}`, { totalScore: 100 - i }));
    players[5].siblingId = players[6].id;
    players[6].siblingId = players[5].id;
    const result = runSimulation(players, teams, teams.map(t => t.id), format, options);
    expect(result.players.every(p => p.isDrafted)).toBe(true);
    expect(result.teams.map(t => t.roster.length)).toEqual([2, 2, 2, 2, 2]);
    expect(result.players.find(p => p.draftedAtPick === 6)?.id).toBe('p7');
    expect(players.every(p => !p.isDrafted)).toBe(true);
    expect(teams.every(t => t.roster.length === 0)).toBe(true);
  });

  it('keeps a normal pair together when space permits', () => {
    const teams = [team('a', 1), team('b', 2)];
    const players = [
      player('first', { totalScore: 100, siblingId: 'second', projectedRound: 1 }),
      player('second', { totalScore: 80, siblingId: 'first' }),
      player('single-one', { totalScore: 90 }), player('single-two', { totalScore: 70 }),
    ];
    const result = runSimulation(players, teams, ['a', 'b'], 'snake', options);
    expect(result.players[0].draftedByTeamId).toBe(result.players[1].draftedByTeamId);
    expect(result.players.every(p => p.isDrafted)).toBe(true);
  });

  it('reserves a future coach pick before starting a sibling pair', () => {
    const teams = [team('a', 1), team('b', 2), team('c', 3)];
    const players = [
      player('first', { totalScore: 100, siblingId: 'second' }),
      player('second', { totalScore: 90, siblingId: 'first' }),
      player('single-one', { totalScore: 80 }), player('single-two', { totalScore: 70 }),
      player('single-three', { totalScore: 60 }),
      player('coach-a', { totalScore: 0, isCoachKid: true, coachTeamId: 'a' }),
    ];
    const result = runSimulation(players, teams, ['a', 'b', 'c'], 'straight', options);
    expect(result.players.every(p => p.isDrafted)).toBe(true);
    expect(result.players[5].draftedByTeamId).toBe('a');
    expect(result.players[0].draftedByTeamId).toBe(result.players[1].draftedByTeamId);
  });

  it('handles empty inputs and disabled rules', () => {
    expect(runSimulation([], [team('a', 1)], ['a'], 'straight', options).players).toEqual([]);
    const players = [player('a', { siblingId: 'b' }), player('b', { siblingId: 'a' })];
    const result = runSimulation(players, [team('a', 1), team('b', 2)], ['a', 'b'], 'straight', {
      includeCoachKids: false, includeSiblings: false,
    });
    expect(result.players.every(p => p.isDrafted)).toBe(true);
  });

  it('simulation keeps an existing reservation after a sibling is taken by another team', () => {
    const players = [
      player('root', { totalScore: 100, siblingId: 'kept', rank: 2 }),
      player('kept', { totalScore: 10, siblingId: 'released', lockedToTeamId: 'a', rank: 1 }),
      player('released', { totalScore: 20, siblingId: 'root', lockedToTeamId: 'b', projectedRound: 1, rank: 3 }),
      player('single', { totalScore: 50 }),
    ];
    const result = runSimulation(players, [team('a', 1), team('b', 2)], ['a', 'b'], 'straight', options);
    expect(result.players[1].draftedByTeamId).toBe('a');
    expect(result.players[2].draftedByTeamId).toBe('b');
    expect(result.players.every(player => player.isDrafted)).toBe(true);
  });

  it.each(['straight', 'snake', 'recalculated'] as const)('reserves a future coach kid’s entire sibling group in %s', (format) => {
    const players = [
      player('A', { totalScore: 100, siblingId: 'B' }),
      player('B', { totalScore: 99, siblingId: 'A' }),
      player('Coach', { totalScore: 10, isCoachKid: true, coachTeamId: 'a', siblingId: 'Coach sibling' }),
      player('Coach sibling', { totalScore: 9, siblingId: 'Coach', projectedRound: 3 }),
      player('Single 1', { totalScore: 80 }), player('Single 2', { totalScore: 70 }),
    ];
    const result = runSimulation(players, [team('a', 1), team('b', 2)], ['a', 'b'], format, options);
    expect(result.players[0].draftedByTeamId).toBe('b');
    expect(result.players[1].draftedByTeamId).toBe('b');
    expect(result.players[2].draftedByTeamId).toBe('a');
    expect(result.players[3].draftedByTeamId).toBe('a');
    expect(result.players.every(player => player.isDrafted)).toBe(true);
  });
});
