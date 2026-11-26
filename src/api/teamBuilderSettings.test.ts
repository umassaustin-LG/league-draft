import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';
import { restoreRequestResolutions } from '../utils/teamBuilderSettings';
import type { ResolvedRequest, TeamBuilderSettings } from '../types';

const request: ResolvedRequest = {
  id: 'old-id', playerId: 'p1', requestType: 'teammate', rawRequestString: 'Blake', resolvedTargetId: 'p2',
  resolvedTargetName: 'Blake', status: 'user-confirmed', confidenceScore: 0.5, isTwoWay: false,
};
const settings: TeamBuilderSettings = {
  config: { minRosterSize: 2, maxRosterSize: 14, forceEvenTeams: true },
  algorithmMode: 'balance-first', resolvedRequests: [request],
};
afterEach(() => vi.unstubAllGlobals());

describe('persisted Team Builder settings', () => {
  it('round-trips configuration and manual resolutions through the division API', async () => {
    vi.stubGlobal('document', { cookie: '' });
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({
      players: [], teams: [], team_builder_settings: settings,
    }))));
    vi.stubGlobal('fetch', fetch);
    expect((await api.updateDivision('division', { teamBuilderSettings: settings })).teamBuilderSettings).toEqual(settings);
    expect(JSON.parse(fetch.mock.calls[0][1].body).team_builder_settings).toEqual(settings);
    expect((await api.getDivision('division')).teamBuilderSettings).toEqual(settings);
  });

  it('restores manual decisions by player/type/raw request rather than generated request IDs', () => {
    const prepared = { ...request, id: 'new-id', resolvedTargetId: null, status: 'needs-review' as const };
    expect(restoreRequestResolutions([prepared], [request], ['p1', 'p2'], []))
      .toEqual([{ ...prepared, resolvedTargetId: 'p2', resolvedTargetName: 'Blake', status: 'user-confirmed' }]);
    expect(restoreRequestResolutions([prepared], [{ ...request, status: 'unresolvable', resolvedTargetId: null, resolvedTargetName: null }], [], []))
      .toEqual([{ ...prepared, status: 'unresolvable', resolvedTargetName: null }]);
    expect(restoreRequestResolutions([prepared], [request], ['p1'], [])).toEqual([prepared]);
    expect(restoreRequestResolutions([prepared], [], [], [])).toEqual([prepared]);
    expect(restoreRequestResolutions([], [request], [], [])).toEqual([]);
  });
});
