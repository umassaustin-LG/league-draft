import { expect, test, type Page } from '@playwright/test';

const orgId = 'league-a';
const createdAt = '2026-01-01T12:00:00Z';

function snapshot(
  id: string, name: string, phase: 'upload' | 'config' | 'draft' | 'complete',
  generated = false, assigned = phase === 'complete',
) {
  const complete = phase === 'complete';
  const player = {
    id: 'player-a', bib: '1', name: 'Sandy Rivera', first_name: 'Sandy', last_name: 'Rivera',
    total_score: 92, little_league_age: 11, is_drafted: assigned,
    drafted_by_team_id: assigned ? 'team-a' : null,
  };
  return {
    id, name, phase, organization_id: orgId, created_at: createdAt,
    mode: generated ? 'league-generated' : 'live-draft',
    has_generated_rosters: generated && assigned,
    preset: 'majors', team_count: 2, player_count: 1, roster_size: 1,
    age_range: { min: 10, max: 12 },
    players: [player],
    teams: [
      { id: 'team-a', name: 'Owls', head_coach: 'Miller', draft_position: 1, total_score: assigned ? 92 : 0, roster: assigned ? [player] : [] },
      { id: 'team-b', name: 'Foxes', head_coach: 'Chen', draft_position: 2, roster: [] },
    ],
    draft_state: phase === 'upload' || phase === 'config' || generated ? null : {
      id: 'draft-a', draft_format: 'snake', draft_order: ['team-a', 'team-b'],
      current_round_order: ['team-a', 'team-b'], current_round: 1, current_pick_in_round: 1,
      current_team_id: complete ? null : 'team-a', is_draft_complete: complete, picks: [], trades: [],
    },
  };
}

async function mockLeague(page: Page, role: 'admin' | 'coach' | 'viewer', signedIn = true) {
  const user = {
    id: role, email: `${role}@example.test`, role: 'user',
    organizations: [{ organization_id: orgId, organization_name: 'Northeast Little League', role }],
  };
  const divisions = {
    setup: snapshot('setup', 'Preparing Majors', 'config'),
    live: snapshot('live', 'Live Majors', 'draft'),
    final: snapshot('final', 'Final AAA', 'complete'),
    generated: snapshot('generated', 'Generated AA', 'upload', true, true),
    preparing: snapshot('preparing', 'Preparing AA', 'upload', true),
  };
  const writes: string[] = [];
  await page.route(url => url.pathname.startsWith('/api/'), async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === '/api/auth/csrf/') return route.fulfill({ json: {} });
    if (path === '/api/auth/login/') {
      signedIn = true;
      return route.fulfill({ json: user });
    }
    if (path === '/api/auth/me/') {
      return route.fulfill(signedIn ? { json: user } : { status: 401, json: {} });
    }
    if (request.method() !== 'GET') {
      writes.push(`${request.method()} ${path}`);
      return route.fulfill({ status: 403, json: { error: 'Not allowed' } });
    }
    if (path === '/api/divisions/') return route.fulfill({ json: Object.values(divisions) });
    const id = path.match(/^\/api\/divisions\/([^/]+)\/$/)?.[1] as keyof typeof divisions | undefined;
    if (id && divisions[id]) return route.fulfill({ json: divisions[id] });
    return route.fulfill({ status: 404, json: {} });
  });
  return { divisions, writes };
}

test('coach can follow the live draft without league management controls', async ({ page }) => {
  const { divisions, writes } = await mockLeague(page, 'coach', false);
  await page.goto('/');
  await page.locator('#email').fill('coach@example.test');
  await page.locator('#password').fill('FixturePassword123!');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByRole('button', { name: 'View Draft' })).toBeVisible();
  await expect(page.getByRole('button', { name: /create .*division|evaluation setup/i })).toHaveCount(0);
  await expect(page.getByTitle('Delete division')).toHaveCount(0);

  await page.getByRole('article', { name: 'Preparing Majors' }).getByRole('button', { name: 'View Division' }).click();
  await expect(page.getByText('The league is still setting up', { exact: false })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Divisions' }).click();
  await page.getByRole('button', { name: 'View Draft' }).click();
  await expect(page.getByRole('heading', { name: 'Owls' })).toBeVisible();
  await expect(page.getByRole('button', { name: /^(draft|undo|skip|reset|finalize)/i })).toHaveCount(0);
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+z');

  // The league advances the round in another session. No coach interaction is required.
  divisions.live.draft_state = {
    ...divisions.live.draft_state!, current_team_id: 'team-b', current_round: 2,
    current_round_order: ['team-b', 'team-a'],
  };
  await expect(page.getByRole('heading', { name: 'Foxes' })).toBeVisible();
  await expect(page.getByRole('dialog')).toHaveCount(0);

  divisions.live = snapshot('live', 'Live Majors', 'complete');
  await expect(page.getByRole('heading', { name: 'Team rosters' })).toBeVisible();
  await expect(page.getByText('Sandy Rivera')).toBeVisible();
  await expect(page.getByText(/pts|^92\.0$/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: /trade|return to draft setup|back to draft board/i })).toHaveCount(0);
  await expect(page.getByText('Assign Team Names')).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('viewer sees generated rosters without entering Team Builder', async ({ page }) => {
  const { writes } = await mockLeague(page, 'viewer');
  await page.goto('/');
  const generated = page.getByRole('article', { name: 'Generated AA' });
  await expect(generated.getByText('Rosters Ready')).toBeVisible();
  await expect(page.getByRole('article', { name: 'Preparing AA' }).getByRole('button', { name: 'View Division' })).toBeVisible();
  await generated.getByRole('button', { name: 'View Rosters' }).click();
  await expect(page.getByRole('heading', { name: 'Generated AA', exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Team rosters' })).toBeVisible();
  await expect(page.getByText('Sandy Rivera')).toBeVisible();
  await expect(page.getByText(/pts|^92\.0$/)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Download rosters' })).toBeVisible();
  await expect(page.getByRole('button', { name: /trade|generate|reset/i })).toHaveCount(0);
  expect(writes).toEqual([]);
});

test('league admin keeps draft and roster management controls', async ({ page }) => {
  await mockLeague(page, 'admin');
  await page.goto('/');
  await expect(page.getByRole('button', { name: /^Create New Division/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Evaluation Setup' })).toBeVisible();
  await page.getByRole('article', { name: 'Final AAA' }).getByRole('button', { name: 'View Results' }).click();
  await expect(page.getByRole('button', { name: 'Make Trade' })).toBeVisible();
  await expect(page.getByText('Assign Team Names')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Return to Draft Setup' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to Divisions' }).click();
  await page.getByRole('article', { name: 'Live Majors' }).getByRole('button', { name: 'Resume' }).click();
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Reset' })).toBeVisible();
});

test('presentation mode requires sign-in and does not expose admin actions', async ({ page }) => {
  const { writes } = await mockLeague(page, 'admin', false);
  await page.goto('/?view=public');
  await expect(page.getByRole('button', { name: 'Sign In' })).toBeVisible();
  await page.locator('#email').fill('admin@example.test');
  await page.locator('#password').fill('FixturePassword123!');
  await page.getByRole('button', { name: 'Sign In' }).click();
  await expect(page.getByRole('button', { name: /create .*division|evaluation setup/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'View Draft' }).click();
  await expect(page.getByRole('heading', { name: 'Owls' })).toBeVisible();
  await expect(page.getByRole('button', { name: /scores|undo|skip|reset/i })).toHaveCount(0);
  expect(writes).toEqual([]);
});
