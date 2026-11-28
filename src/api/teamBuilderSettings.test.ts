import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';
import { remapSavedResolutions, restoreRequestResolutions, saveRequestResolutions } from '../utils/teamBuilderSettings';
import type { ResolvedRequest, TeamBuilderSettings } from '../types';

const request: ResolvedRequest = {
  id: 'old-id', playerId: 'p1', requestType: 'teammate', rawRequestString: 'Blake', resolvedTargetId: 'p2',
  resolvedTargetName: 'Blake', status: 'user-confirmed', confidenceScore: 0.5, isTwoWay: false,
};
const settings: TeamBuilderSettings = {
  config: { minRosterSize: 2, maxRosterSize: 14, forceEvenTeams: true },
  algorithmMode: 'balance-first', resolvedRequests: [request],
};
const players = [
  { id: 'p1', bib: '101', firstName: 'Avery', lastName: 'River', name: 'Avery River' },
  { id: 'p2', bib: '102', firstName: 'Blake', lastName: 'River', name: 'Blake' },
];
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
    expect(restoreRequestResolutions([prepared], [request], players, []))
      .toEqual([{ ...prepared, resolvedTargetId: 'p2', resolvedTargetName: 'Blake', status: 'user-confirmed' }]);
    expect(restoreRequestResolutions([prepared], [{ ...request, status: 'unresolvable', resolvedTargetId: null, resolvedTargetName: null }], players, []))
      .toEqual([{ ...prepared, status: 'unresolvable', resolvedTargetName: null }]);
    expect(restoreRequestResolutions([prepared], [request], players.slice(0, 1), [])).toEqual([prepared]);
    expect(restoreRequestResolutions([prepared], [], [], [])).toEqual([prepared]);
    expect(restoreRequestResolutions([], [request], [], [])).toEqual([]);
  });

  it('restores both requester and teammate after generation and finalization recreate their IDs', () => {
    const saved = JSON.parse(JSON.stringify(saveRequestResolutions([request], players)));
    const recreated = players.map(player => ({ ...player, id: `generation-${player.id}` }));
    const prepared = { ...request, id: 'new-request', playerId: recreated[0].id,
      status: 'needs-review' as const, resolvedTargetId: null };
    const restored = restoreRequestResolutions([prepared], saved, recreated, []);
    expect(restored[0]).toMatchObject({ playerId: recreated[0].id, resolvedTargetId: recreated[1].id, status: 'user-confirmed' });
    const finalized = recreated.map(player => ({ ...player, id: `finalized-${player.id}`, firstName: ` ${player.firstName.toUpperCase()} ` }));
    expect(remapSavedResolutions(saved, finalized, [])[0]).toMatchObject({
      playerId: finalized[0].id, resolvedTargetId: finalized[1].id, status: 'user-confirmed',
    });
  });

  it('preserves coach and unresolvable decisions without matching ambiguous or removed players', () => {
    const saved = saveRequestResolutions([
      { ...request, requestType: 'coach', resolvedTargetId: 't1' },
      { ...request, id: 'unresolved', status: 'unresolvable', resolvedTargetId: null, resolvedTargetName: null },
    ], players);
    const recreated = players.map(player => ({ ...player, id: `new-${player.id}` }));
    expect(remapSavedResolutions(saved, recreated, ['t1'])).toMatchObject([
      { playerId: 'new-p1', resolvedTargetId: 't1' }, { playerId: 'new-p1', resolvedTargetId: null, status: 'unresolvable' },
    ]);
    expect(remapSavedResolutions(saved, [], ['t1'])).toEqual([]);
    expect(remapSavedResolutions(saved, [...recreated, { ...recreated[0], id: 'duplicate' }], ['t1'])).toEqual([]);
  });
});
