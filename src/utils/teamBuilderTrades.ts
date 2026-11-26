import { Player, TradeCandidate } from '../types';

export function isSuggestedTradeCurrent(trade: TradeCandidate, players: Player[]): boolean {
  return trade.player1Id !== trade.player2Id && trade.fromTeamId !== trade.toTeamId &&
    players.some(player => player.id === trade.player1Id && player.draftedByTeamId === trade.fromTeamId) &&
    players.some(player => player.id === trade.player2Id && player.draftedByTeamId === trade.toTeamId);
}
