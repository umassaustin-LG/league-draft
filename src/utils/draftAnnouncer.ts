import { DraftPick, Player, Team } from '../types';
import { getTeamDisplayName } from './teamUtils';

export const pickSignature = (picks: DraftPick[]): string => JSON.stringify(picks.map(
  ({ round, pick, teamId, playerId, wasSkipped, timestamp }) =>
    [round, pick, teamId, playerId, !!wasSkipped, timestamp]
));

export function newestAppendedPick(previous: DraftPick[], current: DraftPick[]): DraftPick | null {
  if (current.length <= previous.length ||
      pickSignature(current.slice(0, previous.length)) !== pickSignature(previous)) return null;
  const last = current[current.length - 1];
  return last.playerId && !last.wasSkipped ? last : null;
}

export function buildAnnouncement(pick: DraftPick, teams: Team[], players: Player[]): string | null {
  const team = teams.find(t => t.id === pick.teamId);
  const player = players.find(p => p.id === pick.playerId);
  if (!team || !player || pick.wasSkipped) return null;
  const overall = (pick.round - 1) * teams.length + pick.pick;
  return `With pick ${overall}, the ${getTeamDisplayName(team)} select ${player.firstName} ${player.lastName}.`;
}
