import type { Player } from '../types';

export function getUnassignedPlayers(players: Player[]) {
  return players.filter(player => !player.draftedByTeamId);
}

export function confirmTeamBuilderFinalization(players: Player[], confirm: (message: string) => boolean): boolean {
  const unassigned = getUnassignedPlayers(players);
  return unassigned.length === 0 || confirm(
    `${unassigned.length} of ${players.length} players are unassigned: ${unassigned.map(player => player.name).join(', ')}. Finalize teams anyway?`,
  );
}
