import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { api, getAnnouncerStatus, speakAnnouncement } from './client';
import { getActiveOrganizationId, selectActiveOrganization } from './activeOrganization';
import { DivisionSelector } from '../components/DivisionSelector';
import type { User, OrganizationMembership, DivisionSummary } from '../types';
import { canSelectPersonalWorkspace, divisionNameExistsInWorkspace, isDivisionInWorkspace } from '../utils/divisionAccess';

const membership = (id: string) => ({ organizationId: id, organizationName: id, role: 'admin' } as OrganizationMembership);
const user = (id = 'user', organizations = [membership('one'), membership('two')]): User => ({
  id, organizations, leagues: organizations, email: `${id}@example.com`, firstName: '', lastName: '', role: 'user',
});

afterEach(() => { selectActiveOrganization(null); vi.unstubAllGlobals(); });

describe('active league selection', () => {
  it('defaults, switches and restores selection per user and sends it on reads and writes', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    vi.stubGlobal('document', { cookie: '' });
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response('[]')));
    vi.stubGlobal('fetch', fetch);
    expect(selectActiveOrganization(user())).toBe('one');
    await api.listDivisions();
    expect(fetch.mock.calls[0][1].headers['X-Organization-ID']).toBe('one');
    expect(selectActiveOrganization(user(), 'two')).toBe('two');
    await api.logout();
    expect(fetch.mock.calls[1][1].headers['X-Organization-ID']).toBe('two');
    expect(selectActiveOrganization(user('other'))).toBe('one');
    expect(selectActiveOrganization(user())).toBe('two');
    expect(selectActiveOrganization(user(), 'foreign')).toBe('one');
    expect(selectActiveOrganization(user('single', [membership('single-league')]))).toBe('single-league');
    expect(selectActiveOrganization(user('personal', []))).toBeNull();
    await api.listDivisions();
    expect(fetch.mock.calls[2][1].headers['X-Organization-ID']).toBeUndefined();
  });

  it('selects a newly accepted membership after refreshing the user and tolerates unavailable storage', () => {
    vi.stubGlobal('localStorage', { getItem: () => { throw new Error('blocked'); } });
    expect(selectActiveOrganization(user('user', [membership('one')]))).toBe('one');
    expect(selectActiveOrganization(user(), 'two')).toBe('two');
    expect(getActiveOrganizationId()).toBe('two');
    selectActiveOrganization(null);
    expect(getActiveOrganizationId()).toBeNull();
  });

  it('only renders the league selector for multiple memberships', () => {
    const render = (account: User) => renderToStaticMarkup(createElement(DivisionSelector, {
      user: account, divisions: [], onSelectDivision: vi.fn(), onLogout: vi.fn(),
      activeOrganizationId: 'one', onSwitchOrganization: vi.fn(),
    }));
    expect(render(user())).toContain('Active league');
    expect(render(user())).toContain('<option value="">Personal</option>');
    expect(render(user('single', [membership('one')]))).not.toContain('Active league');
  });

  it('persists Personal for multi-membership users and omits the tenant header for division and announcer requests', async () => {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key), setItem: (key: string, value: string) => values.set(key, value),
      removeItem: (key: string) => values.delete(key),
    });
    vi.stubGlobal('document', { cookie: '' });
    const fetch = vi.fn().mockImplementation(() => Promise.resolve(new Response(JSON.stringify({ enabled: true }))));
    vi.stubGlobal('fetch', fetch);
    expect(selectActiveOrganization(user(), 'two')).toBe('two');
    await getAnnouncerStatus();
    expect(fetch.mock.calls[0][1].headers['X-Organization-ID']).toBe('two');
    expect(selectActiveOrganization(user(), '')).toBeNull();
    expect(values.get('active-organization:user')).toBe('');
    fetch.mockResolvedValueOnce(new Response('[]'));
    await api.listDivisions();
    expect(fetch.mock.calls[1][1].headers['X-Organization-ID']).toBeUndefined();
    await getAnnouncerStatus();
    await speakAnnouncement('Personal draft pick', new AbortController().signal);
    expect(fetch.mock.calls[2][1].headers['X-Organization-ID']).toBeUndefined();
    expect(fetch.mock.calls[3][1].headers['X-Organization-ID']).toBeUndefined();
    expect(selectActiveOrganization(user())).toBeNull();
    expect(selectActiveOrganization(user(), 'one')).toBe('one');
    expect(selectActiveOrganization(user())).toBe('one');
    expect(selectActiveOrganization(user('single', [membership('one')]), '')).toBe('one');
    expect(canSelectPersonalWorkspace(user('single', [membership('one')]))).toBe(false);
    expect(canSelectPersonalWorkspace({ ...user('master', [membership('one')]), role: 'master_admin' })).toBe(true);
    expect(canSelectPersonalWorkspace(user('none', []))).toBe(true);
    expect(canSelectPersonalWorkspace(null)).toBe(false);
  });

  it('scopes visible divisions and duplicate names to the selected workspace', () => {
    const divisions = [
      { id: 'personal', name: 'AA', playerCount: 2 },
      { id: 'league-one', name: 'Majors', playerCount: 2, organizationId: 'one' },
      { id: 'league-two', name: 'AAA', playerCount: 2, organizationId: 'two' },
      { id: 'empty', name: 'Empty', playerCount: 0, organizationId: 'one' },
    ] as DivisionSummary[];
    expect(divisions.filter(division => isDivisionInWorkspace(division, null)).map(division => division.id)).toEqual(['personal']);
    expect(divisionNameExistsInWorkspace(divisions, ' aa ', null)).toBe(true);
    expect(divisionNameExistsInWorkspace(divisions, 'AA', 'one')).toBe(false);
    expect(divisionNameExistsInWorkspace(divisions, 'majors', 'one')).toBe(true);
    expect(divisionNameExistsInWorkspace(divisions, 'Majors', 'two')).toBe(false);
    expect(divisionNameExistsInWorkspace(divisions, 'Empty', 'one')).toBe(false);
    expect(divisionNameExistsInWorkspace([], 'AA', null)).toBe(false);
    expect(isDivisionInWorkspace(divisions[0], 'one')).toBe(false);
    expect(isDivisionInWorkspace(divisions[1], null)).toBe(false);
  });
});
