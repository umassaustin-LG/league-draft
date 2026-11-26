import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { api } from '../api/client';
import type { Division, DraftState, Player, Team } from '../types';
import { useDraft } from './useDraft';

const hooks = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0 }));

vi.mock('react', () => ({
  useState: (initial: unknown) => {
    const index = hooks.cursor++;
    if (index >= hooks.values.length) hooks.values[index] = typeof initial === 'function' ? initial() : initial;
    return [hooks.values[index], (value: unknown) => {
      hooks.values[index] = typeof value === 'function' ? value(hooks.values[index]) : value;
    }];
  },
  useRef: (initial: unknown) => {
    const index = hooks.cursor++;
    if (index >= hooks.values.length) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
}));

const renderHook = () => {
  hooks.cursor = 0;
  return useDraft('division');
};

const players = Array.from({ length: 10 }, (_, i) => ({
  id: `p${i}`, name: `Player ${i}`, isDrafted: i < 9,
} as Player));
const state: DraftState = {
  id: 'draft', players, teams: Array.from({ length: 5 }, (_, i) => ({ id: `t${i}` } as Team)),
  draftFormat: 'snake', draftOrder: ['t0', 't1', 't2', 't3', 't4'],
  currentRoundOrder: ['t4', 't3', 't2', 't1', 't0'], currentRound: 2, currentPickInRound: 5,
  currentTeamId: 't0', isDraftComplete: false, trades: [], picks: [],
};
const division = { id: 'division', phase: 'draft', draftState: state, players, teams: state.teams } as Division;

beforeEach(() => {
  hooks.values = [];
  hooks.cursor = 0;
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('draft finalization', () => {
  it.each(['pick', 'skip'] as const)('keeps the confirmation pending after the last snake %s, including on reload', async action => {
    renderHook().loadDivisionState(division);
    const completed: DraftState = { ...state, isDraftComplete: true, currentTeamId: null,
      players: action === 'pick' ? players.map(player => ({ ...player, isDrafted: true })) : players };
    const result = { draftState: completed, players: completed.players, teams: state.teams };
    if (action === 'pick') {
      vi.spyOn(api, 'draftPlayer').mockResolvedValue(result);
      await renderHook().draftPlayer('p9');
    } else {
      vi.spyOn(api, 'skipPick').mockResolvedValue(result);
      await renderHook().skipPick();
    }
    vi.runAllTimers();
    expect(renderHook().draftState.isDraftComplete).toBe(true);
    expect(renderHook().phase).toBe('draft');
    expect(renderHook().pendingComplete).toBe(true);
    renderHook().loadDivisionState({ ...division, draftState: completed });
    expect(renderHook().phase).toBe('draft');
    expect(renderHook().pendingComplete).toBe(true);
    renderHook().cancelPendingComplete();
    expect(renderHook().phase).toBe('draft');
    expect(renderHook().pendingComplete).toBe(false);
    renderHook().finalizeDraft();
    expect(renderHook().phase).toBe('complete');
    expect(renderHook().pendingComplete).toBe(false);
  });

  it('reviews a finalized board and returns to results without changing the phase or draft data', () => {
    renderHook().loadDivisionState({ ...division, phase: 'complete', draftState: { ...state, isDraftComplete: true } });
    const before = renderHook().draftState;
    renderHook().returnToDraftBoard();
    expect(renderHook().phase).toBe('complete');
    expect(renderHook().isViewingCompletedDraftBoard).toBe(true);
    expect(renderHook().draftState).toBe(before);
    renderHook().viewResults();
    expect(renderHook().phase).toBe('complete');
    expect(renderHook().isViewingCompletedDraftBoard).toBe(false);
    expect(renderHook().draftState).toBe(before);
  });

  it('does not prompt to finalize an unfinished or empty draft', () => {
    renderHook().loadDivisionState(division);
    expect(renderHook().pendingComplete).toBe(false);
    renderHook().loadDivisionState({ ...division, phase: 'upload', draftState: null, players: [], teams: [] });
    expect(renderHook().pendingComplete).toBe(false);
    expect(renderHook().phase).toBe('upload');
  });

  it('leaves the phase and completion prompt unchanged if the final pick fails', async () => {
    renderHook().loadDivisionState(division);
    vi.spyOn(api, 'draftPlayer').mockRejectedValue(new Error('Save failed'));
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await renderHook().draftPlayer('p9');
    vi.runAllTimers();
    expect(renderHook().phase).toBe('draft');
    expect(renderHook().pendingComplete).toBe(false);
    expect(renderHook().error).toBeTruthy();
    expect(log).toHaveBeenCalled();
  });
});
