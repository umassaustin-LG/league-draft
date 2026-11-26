import type { ResolvedRequest } from '../types';

export function restoreRequestResolutions(prepared: ResolvedRequest[], saved: ResolvedRequest[], playerIds: string[], teamIds: string[]) {
  return prepared.map(request => {
    const previous = saved.find(item => item.playerId === request.playerId && item.requestType === request.requestType
      && item.rawRequestString === request.rawRequestString);
    if (!previous || !['user-confirmed', 'unresolvable'].includes(previous.status)) return request;
    const targets = request.requestType === 'coach' ? teamIds : playerIds;
    if (previous.resolvedTargetId && !targets.includes(previous.resolvedTargetId)) return request;
    return { ...request, status: previous.status, resolvedTargetId: previous.resolvedTargetId, resolvedTargetName: previous.resolvedTargetName };
  });
}
