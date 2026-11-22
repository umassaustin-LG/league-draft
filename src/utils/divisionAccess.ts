import type { DivisionSummary, User } from '../types';

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
  return canUsePersonalWorkspace(user) && division.ownerId === user.id;
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

export function getDivisionView(division: Pick<DivisionSummary, 'mode' | 'phase'>) {
  if (division.phase === 'complete') return 'rosters';
  if (division.mode === 'live-draft' && division.phase === 'draft') return 'draft';
  return 'setup';
}
