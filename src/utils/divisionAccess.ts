import type { Division, DivisionSummary, User } from '../types';

export function canSelectPersonalWorkspace(user: User | null): boolean {
  return !!user && (user.role === 'master_admin' || user.organizations.length !== 1);
}

export function isDivisionInWorkspace(division: Pick<DivisionSummary, 'organizationId'>, organizationId?: string | null): boolean {
  return (division.organizationId ?? null) === (organizationId ?? null);
}

export function divisionNameExistsInWorkspace(divisions: DivisionSummary[], name: string, organizationId?: string | null): boolean {
  return divisions.some(division => isDivisionInWorkspace(division, organizationId) && division.playerCount > 0
    && division.name.trim().toLowerCase() === name.trim().toLowerCase());
}

export function canManageDivision(
  user: User | null,
  division: Pick<DivisionSummary, 'organizationId' | 'ownerId'>,
): boolean {
  if (!user) return false;
  if (user.role === 'master_admin') return true;
  if (division.organizationId) {
    return user.organizations.some(
      membership => membership.organizationId === division.organizationId && membership.role === 'admin',
    );
  }
  return division.ownerId === user.id;
}

export function canUsePersonalWorkspace(user: User | null): boolean {
  return !!user && (user.role === 'master_admin' || user.organizations.length === 0 ||
    user.organizations.some(membership => membership.role === 'admin'));
}

// TenantMiddleware selects a league without a header only for a single membership.
export function getDefaultLeagueAdminMembership(user: User | null) {
  const memberships = user?.organizations;
  if (memberships?.length === 1 && memberships[0].role === 'admin') {
    return memberships[0];
  }
  return undefined;
}

export function hasGeneratedRosters(division: Pick<Division, 'mode' | 'teams'>): boolean {
  return division.mode === 'league-generated' && division.teams.some(team => team.roster.length > 0);
}

export function getDivisionView(
  division: Pick<DivisionSummary, 'mode' | 'phase' | 'hasGeneratedRosters'> | Pick<Division, 'mode' | 'phase' | 'teams'>,
) {
  const generated = 'hasGeneratedRosters' in division ? division.hasGeneratedRosters : hasGeneratedRosters(division);
  if (division.phase === 'complete' || generated) return 'rosters';
  if (division.mode === 'live-draft' && division.phase === 'draft') return 'draft';
  return 'setup';
}
