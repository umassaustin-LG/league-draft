import type { User } from '../types';
import { canSelectPersonalWorkspace } from '../utils/divisionAccess';

let activeOrganizationId: string | null = null;
let activeStorageKey: string | null = null;

export function clearInvalidOrganization(rejectedId: string | null): boolean {
  if (!rejectedId || rejectedId !== activeOrganizationId) return false;
  activeOrganizationId = null;
  try { if (activeStorageKey) localStorage.removeItem(activeStorageKey); } catch { /* Storage may be unavailable. */ }
  return true;
}

export function getActiveOrganizationId() {
  return activeOrganizationId;
}

export function selectActiveOrganization(user: User | null, preferredId?: string): string | null {
  activeOrganizationId = null;
  activeStorageKey = user ? `active-organization:${user.id}` : null;
  if (!user) return null;
  const key = `active-organization:${user.id}`;
  let savedId: string | null = null;
  try { savedId = localStorage.getItem(key); } catch { /* Storage may be unavailable. */ }
  const memberships = user.organizations;
  const selectedId = preferredId ?? savedId;
  const personal = selectedId === '' && canSelectPersonalWorkspace(user);
  activeOrganizationId = personal ? null : memberships.find(m => m.organizationId === selectedId)?.organizationId
    ?? memberships[0]?.organizationId ?? null;
  try {
    if (activeOrganizationId) localStorage.setItem(key, activeOrganizationId);
    else if (canSelectPersonalWorkspace(user)) localStorage.setItem(key, '');
    else localStorage.removeItem(key);
  } catch { /* Keep the selection for this session. */ }
  return activeOrganizationId;
}
