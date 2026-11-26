import { afterEach, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { api } from './client';
import { getActiveOrganizationId, selectActiveOrganization } from './activeOrganization';
import { DivisionSelector } from '../components/DivisionSelector';
import type { User, OrganizationMembership } from '../types';

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
    expect(render(user('single', [membership('one')]))).not.toContain('Active league');
  });
});
