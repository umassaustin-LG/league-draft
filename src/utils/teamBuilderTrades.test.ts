import { describe, expect, it } from 'vitest';
import { Player, TradeCandidate } from '../types';
import { isSuggestedTradeCurrent } from './teamBuilderTrades';

const trade = { player1Id: 'a', player2Id: 'b', fromTeamId: 't1', toTeamId: 't2' } as TradeCandidate;
const players = [{ id: 'a', draftedByTeamId: 't1' }, { id: 'b', draftedByTeamId: 't2' }] as Player[];

describe('suggested trade validation', () => {
  it('accepts a suggestion whose assignments still match', () => {
    expect(isSuggestedTradeCurrent(trade, players)).toBe(true);
  });
  it('rejects a suggestion after a player is manually swapped to a third team', () => {
    expect(isSuggestedTradeCurrent(trade, [{ ...players[0], draftedByTeamId: 't3' }, players[1]])).toBe(false);
  });
  it('rejects missing players and self trades', () => {
    expect(isSuggestedTradeCurrent(trade, [])).toBe(false);
    expect(isSuggestedTradeCurrent({ ...trade, player2Id: 'a' }, players)).toBe(false);
    expect(isSuggestedTradeCurrent({ ...trade, toTeamId: 't1' }, players)).toBe(false);
  });
});
