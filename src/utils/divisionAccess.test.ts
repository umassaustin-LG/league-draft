import { afterEach, describe, expect, it, vi } from 'vitest';
import type { User } from '../types';
import { api } from '../api/client';
import { canManageDivision } from './divisionAccess';

const user = (roles: ('coach' | 'viewer' | 'admin')[]): User => ({
  id: 'owner', email: 'owner@example.com', firstName: 'Owner', lastName: 'User', role: 'user', leagues: [],
  organizations: roles.map((role, index) => ({
    id: `membership-${index}`, createdAt: '2026-01-01',
    organizationId: `league-${index}`, organizationName: `League ${index}`, organizationSlug: `league-${index}`, role,
    leagueId: `league-${index}`, leagueName: `League ${index}`, leagueSlug: `league-${index}`,
  })),
});

afterEach(() => vi.unstubAllGlobals());

describe('division management permissions', () => {
  it.each([{ roles: ['coach', 'viewer'] }, { roles: ['viewer', 'viewer'] }, { roles: ['coach'] }, { roles: [] }] as const)(
    'lets personal owners manage their division independently of membership roles: $roles', ({ roles }) => {
      expect(canManageDivision(user([...roles]), { ownerId: 'owner' })).toBe(true);
    },
  );

  it('denies anonymous users, other personal owners, and divisions with missing ownership', () => {
    expect(canManageDivision(null, { ownerId: 'owner' })).toBe(false);
    expect(canManageDivision(user(['admin']), { ownerId: 'someone-else' })).toBe(false);
    expect(canManageDivision(user([]), {})).toBe(false);
  });

  it('requires admin membership in the division’s own organization, even when the owner id matches', () => {
    const member = user(['coach', 'admin']);
    expect(canManageDivision(member, { organizationId: 'league-0', ownerId: 'owner' })).toBe(false);
    expect(canManageDivision(member, { organizationId: 'league-1' })).toBe(true);
    expect(canManageDivision(member, { organizationId: 'unrelated' })).toBe(false);
  });

  it('lets master admins manage both personal and organization divisions', () => {
    const master: User = { ...user([]), role: 'master_admin' };
    expect(canManageDivision(master, { ownerId: 'someone-else' })).toBe(true);
    expect(canManageDivision(master, { organizationId: 'unrelated' })).toBe(true);
  });
});

describe('division ownership API payloads', () => {
  it.each([
    { id: 'personal', owner_id: 'owner', is_personal: true },
    { id: 'league', organization_id: 'league-0', is_personal: false },
  ])('retains ownership in list and detail transformations: $id', async payload => {
    vi.stubGlobal('document', { cookie: '' });
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify([payload])))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ...payload, players: [], teams: [] }))));
    const summaries = await api.listDivisions();
    const division = await api.getDivision(payload.id);
    for (const value of [summaries[0], division]) {
      expect(value.ownerId).toBe('owner_id' in payload ? payload.owner_id : undefined);
      expect(value.organizationId).toBe('organization_id' in payload ? payload.organization_id : undefined);
      expect(canManageDivision(user(['coach', 'viewer']), value)).toBe(payload.is_personal);
    }
  });
});
