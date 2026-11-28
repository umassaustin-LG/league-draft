import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Division, DivisionSummary, User } from './types';
import App from './App';
import { JoinPage } from './components/JoinPage';
import { ResetPasswordPage } from './components/ResetPasswordPage';
import { DivisionCreator } from './components/DivisionCreator';
import { api } from './api/client';

const harness = vi.hoisted(() => ({
  values: [] as unknown[], cursor: 0, effects: [] as (() => void)[],
  auth: { user: null as User | null, isAuthenticated: true, isInitialized: true, activeOrganizationId: null as string | null,
    logout: vi.fn(), checkAuth: vi.fn(), switchOrganization: vi.fn() },
  divisions: { summaries: [] as DivisionSummary[], activeDivision: null, clearActiveDivision: vi.fn() },
}));

vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (index >= harness.values.length) harness.values[index] = typeof initial === 'function' ? initial() : initial;
    return [harness.values[index], (value: unknown) => {
      harness.values[index] = typeof value === 'function' ? value(harness.values[index]) : value;
    }];
  },
  useRef: (initial: unknown) => {
    const index = harness.cursor++;
    if (index >= harness.values.length) harness.values[index] = { current: initial };
    return harness.values[index];
  },
  useEffect: (callback: () => (() => void) | undefined, deps: unknown[]) => {
    const index = harness.cursor++;
    const previous = harness.values[index] as { deps: unknown[]; cleanup?: () => void } | undefined;
    if (previous && deps.every((value, i) => Object.is(value, previous.deps[i]))) return;
    const effect = { deps, cleanup: undefined as (() => void) | undefined };
    harness.values[index] = effect;
    harness.effects.push(() => { previous?.cleanup?.(); effect.cleanup = callback(); });
  },
  useMemo: (factory: () => unknown) => factory(),
  useCallback: (callback: unknown) => callback,
}));
vi.mock('./contexts/AuthContext', () => ({ useAuth: () => harness.auth }));
vi.mock('./contexts/ViewContext', () => ({ useViewMode: () => 'admin' }));
vi.mock('./hooks/useDivisions', async importOriginal => ({
  ...await importOriginal<typeof import('./hooks/useDivisions')>(), useDivisions: () => harness.divisions,
}));
vi.mock('./hooks/useDraft', () => ({ useDraft: () => ({
  phase: 'upload', draftState: { players: [], teams: [], picks: [] }, setPhase: vi.fn(), setPlayers: vi.fn(), setTeams: vi.fn(),
}) }));
vi.mock('./hooks/usePlayerScoring', () => ({ usePlayerScoring: () => ({ players: [] }) }));

const { useDivisions } = await vi.importActual<typeof import('./hooks/useDivisions')>('./hooks/useDivisions');
const flushEffects = () => harness.effects.splice(0).forEach(effect => effect());
const renderApp = () => { harness.cursor = 0; return App(); };
const renderDivisions = (organizationId: string | null = 'one') => {
  harness.cursor = 0;
  const result = useDivisions('user', organizationId);
  flushEffects();
  return result;
};

beforeEach(() => {
  harness.values = [];
  harness.effects = [];
  harness.cursor = 0;
  harness.auth.activeOrganizationId = null;
  harness.auth.isAuthenticated = true;
  harness.divisions.summaries = [];
  harness.auth.user = { id: 'user', organizations: [{ organizationId: 'one', role: 'admin' }], leagues: [] } as unknown as User;
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

describe('workspace changes and URL modes', () => {
  it.each(['/join/invite-token', '/join?token=invite-token'])('does not overwrite the invitation route on initial workspace selection: %s', path => {
    const url = new URL(path, 'https://example.com');
    vi.stubGlobal('window', { location: url, scrollTo: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
      history: { replaceState: vi.fn(), pushState: vi.fn() } });
    renderApp();
    flushEffects();
    expect(renderApp().type).toBe(JoinPage);
    harness.auth.activeOrganizationId = 'one';
    renderApp();
    flushEffects();
    const page = renderApp();
    expect(page.type).toBe(JoinPage);
    expect(page.props.token).toBe('invite-token');
  });

  it('keeps password reset parameters when the initial workspace is selected', () => {
    harness.auth.isAuthenticated = false;
    vi.stubGlobal('window', { location: new URL('https://example.com/reset-password?uid=user&token=reset-token'),
      scrollTo: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), history: { replaceState: vi.fn(), pushState: vi.fn() } });
    renderApp();
    flushEffects();
    harness.auth.activeOrganizationId = 'one';
    renderApp();
    flushEffects();
    expect(renderApp().type).toBe(ResetPasswordPage);
  });
});

describe('server-scoped division lists', () => {
  it.each([
    ['one', ['League One']], ['two', ['League Two']], [null, ['Personal']],
  ] as const)('checks creation names only in the selected workspace: %s', (organizationId, existingNames) => {
    vi.stubGlobal('window', { location: new URL('https://example.com'), scrollTo: vi.fn(),
      addEventListener: vi.fn(), removeEventListener: vi.fn(), history: { replaceState: vi.fn(), pushState: vi.fn() } });
    harness.auth.activeOrganizationId = organizationId;
    harness.auth.user!.organizations.push({ organizationId: 'two', role: 'admin' } as User['organizations'][number]);
    harness.divisions.summaries = [
      { id: 'personal', name: 'Personal', playerCount: 2 },
      { id: 'one', organizationId: 'one', name: 'League One', playerCount: 2 },
      { id: 'two', organizationId: 'two', name: 'League Two', playerCount: 2 },
      { id: 'empty', organizationId: 'one', name: 'Empty', playerCount: 0 },
    ] as DivisionSummary[];
    const selector = renderApp();
    expect(selector.props.divisions).toEqual(harness.divisions.summaries);
    selector.props.onCreateNew();
    const creator = renderApp();
    expect(creator.type).toBe(DivisionCreator);
    expect(creator.props.existingNames).toEqual(existingNames);
  });

  it('retains personal divisions for single-membership users and other leagues for master admins', async () => {
    const serverList = [
      { id: 'personal', name: 'Personal', playerCount: 2 },
      { id: 'one', organizationId: 'one', name: 'League One', playerCount: 2 },
      { id: 'other', organizationId: 'other', name: 'Another League', playerCount: 2 },
    ] as DivisionSummary[];
    vi.spyOn(api, 'listDivisions').mockResolvedValue(serverList);
    renderDivisions();
    await vi.waitFor(() => expect(renderDivisions().summaries).toEqual(serverList));
    const personal = { id: 'personal', players: [], teams: [] } as unknown as Division;
    vi.spyOn(api, 'getDivision').mockResolvedValue(personal);
    await renderDivisions().selectDivision('personal');
    expect(renderDivisions().activeDivision).toEqual(personal);
  });

  it('clears the old list and division immediately while the switched workspace loads', async () => {
    const list = vi.spyOn(api, 'listDivisions').mockResolvedValue([{ id: 'one' }] as DivisionSummary[]);
    renderDivisions();
    await vi.waitFor(() => expect(renderDivisions().summaries).toHaveLength(1));
    list.mockReturnValue(new Promise(() => {}));
    expect(renderDivisions('two').summaries).toEqual([]);
    expect(renderDivisions('two').activeDivision).toBeNull();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('handles an empty server list and fetch errors without leaking prior divisions', async () => {
    const list = vi.spyOn(api, 'listDivisions').mockResolvedValue([]);
    renderDivisions();
    await vi.waitFor(() => expect(renderDivisions().isLoading).toBe(false));
    expect(renderDivisions().summaries).toEqual([]);
    list.mockRejectedValue(new Error('Network failed'));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    renderDivisions('two');
    await vi.waitFor(() => expect(renderDivisions('two').error).toBe('Failed to load divisions'));
    expect(renderDivisions('two').summaries).toEqual([]);
  });
});
