import type { Player, ResolvedRequest, SavedRequestResolution } from '../types';

type IdentityPlayer = Pick<Player, 'id' | 'bib' | 'firstName' | 'lastName' | 'name'>;

function playerIdentity(player: IdentityPlayer): string {
  const normalize = (value: string) => value.trim().toLowerCase().replace(/\s+/g, ' ');
  return JSON.stringify([normalize(player.bib), normalize(player.firstName), normalize(player.lastName)]);
}

export function saveRequestResolutions(requests: ResolvedRequest[], players: IdentityPlayer[]): SavedRequestResolution[] {
  return requests.map(request => {
    const requester = players.find(player => player.id === request.playerId);
    const target = request.requestType === 'teammate'
      ? players.find(player => player.id === request.resolvedTargetId) : undefined;
    return { ...request, requesterIdentity: requester ? playerIdentity(requester) : undefined,
      targetPlayerIdentity: target ? playerIdentity(target) : undefined };
  });
}

export function remapSavedResolutions(saved: SavedRequestResolution[], players: IdentityPlayer[], teamIds: string[]): ResolvedRequest[] {
  const findPlayer = (identity: string | undefined, id: string | null) => {
    const matches = players.filter(player => identity ? playerIdentity(player) === identity : player.id === id);
    return matches.length === 1 ? matches[0] : undefined;
  };
  return saved.flatMap(request => {
    const requester = findPlayer(request.requesterIdentity, request.playerId);
    if (!requester) return [];
    if (!request.resolvedTargetId) return [{ ...request, playerId: requester.id }];
    if (request.requestType === 'coach') {
      return teamIds.includes(request.resolvedTargetId) ? [{ ...request, playerId: requester.id }] : [];
    }
    const target = findPlayer(request.targetPlayerIdentity, request.resolvedTargetId);
    return target ? [{ ...request, playerId: requester.id, resolvedTargetId: target.id, resolvedTargetName: target.name }] : [];
  });
}

export function restoreRequestResolutions(prepared: ResolvedRequest[], saved: SavedRequestResolution[], players: IdentityPlayer[], teamIds: string[]) {
  const current = remapSavedResolutions(saved, players, teamIds);
  return prepared.map(request => {
    const previous = current.find(item => item.playerId === request.playerId && item.requestType === request.requestType
      && item.rawRequestString === request.rawRequestString);
    if (!previous || !['user-confirmed', 'unresolvable'].includes(previous.status)) return request;
    return { ...request, status: previous.status, resolvedTargetId: previous.resolvedTargetId, resolvedTargetName: previous.resolvedTargetName };
  });
}
