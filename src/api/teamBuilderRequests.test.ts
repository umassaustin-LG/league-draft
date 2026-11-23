import { afterEach, describe, expect, it, vi } from 'vitest';
import { api } from './client';
import { normalizeRequestData, prepareRequestsForConfirmation } from '../utils/teamBuilderParser';
import { DEFAULT_REQUESTS_FIRST_CONFIG } from '../types';

afterEach(() => vi.unstubAllGlobals());

describe('saved Team Builder requests', () => {
  it('round-trips raw requests and re-derives coach and teammate matches', async () => {
    const raw = { id: 'p1', bib: '1', first_name: 'Avery', last_name: 'River',
      coach_request: 'Smith', teammate_requests: ['Blake River'], school: 'Oak', grade: 2 };
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ players: [raw], teams: [] })))
      .mockResolvedValueOnce(new Response(JSON.stringify([raw])));
    vi.stubGlobal('fetch', fetch);
    vi.stubGlobal('document', { cookie: '' });
    const division = await api.getDivision('division');
    const player = division.players[0];
    expect(player).toMatchObject({ coachRequest: 'Smith', teammateRequests: ['Blake River'], school: 'Oak', grade: 2 });
    const normalization = normalizeRequestData([
      player, { id: 'p2', bib: '2', firstName: 'Blake', lastName: 'River' },
    ], [{ teamId: 't1', teamName: 'Smith', coachName: 'Smith', assistantCoach: '' }]);
    const requests = prepareRequestsForConfirmation(normalization, DEFAULT_REQUESTS_FIRST_CONFIG);
    expect(requests).toContainEqual(expect.objectContaining({ requestType: 'coach', resolvedTargetId: 't1' }));
    expect(requests).toContainEqual(expect.objectContaining({ requestType: 'teammate', resolvedTargetId: 'p2' }));
    await api.bulkCreatePlayers('division', [player]);
    expect(JSON.parse(fetch.mock.calls[1][1].body).players[0]).toMatchObject({
      coach_request: 'Smith', teammate_requests: ['Blake River'], school: 'Oak', grade: 2,
    });
  });

  it('accepts saved players without registration requests', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      players: [{ id: 'p1', first_name: 'Avery', last_name: 'River' }], teams: [],
    }))));
    vi.stubGlobal('document', { cookie: '' });
    expect((await api.getDivision('division')).players[0].teammateRequests).toBeUndefined();
  });
});
