/**
 * API Client for league-draft backend
 * Handles communication with Django REST Framework API
 */

import type {
  Division,
  DivisionSummary,
  DivisionPreset,
  DivisionAgeRange,
  Player,
  Team,
  DraftState,
  DraftFormat,
  ScoringWeights,
  ScoringMode,
  Trade,
  DraftPick,
  User,
  LoginCredentials,
  RegisterData,
  ProfileUpdateData,
  ChangePasswordData,
  OrganizationMember,
  OrganizationInvitation,
  OrganizationMembershipRole,
  JoinLinkStatus,
  JoinLinkInfo,
  AcceptInvitationResult,
  EvaluationTemplate,
  CreateTemplateData,
  Season,
  CreateSeasonData,
} from '../types';

// Legacy type aliases
type LeagueMember = OrganizationMember;
type LeagueInvitation = OrganizationInvitation;
type LeagueMembershipRole = OrganizationMembershipRole;

// API base URL - defaults to local dev server
const API_BASE_URL = import.meta.env.VITE_API_URL || 'http://localhost:8000/api';

// Helper to get CSRF token from cookies
function getCSRFToken(): string | null {
  const cookies = document.cookie.split(';');
  for (const cookie of cookies) {
    const [name, value] = cookie.trim().split('=');
    if (name === 'csrftoken') {
      return value;
    }
  }
  return null;
}

// Default timeout for fetch requests (Issue #23)
const DEFAULT_TIMEOUT_MS = 30000; // 30 seconds

/**
 * Fetch with timeout (Issue #23)
 * Prevents requests from hanging indefinitely
 */
async function fetchWithTimeout(
  url: string,
  options: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
    });
    return response;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new ApiError('Request timed out', 408, { timeout: true });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

// Default fetch options for session-based auth
function getDefaultOptions(method: string = 'GET'): RequestInit {
  const options: RequestInit = {
    credentials: 'include', // Include session cookies
    headers: {
      'Content-Type': 'application/json',
    },
  };

  // Add CSRF token for non-GET requests
  if (method !== 'GET' && method !== 'HEAD') {
    const csrfToken = getCSRFToken();
    if (csrfToken) {
      (options.headers as Record<string, string>)['X-CSRFToken'] = csrfToken;
    }
  }

  return options;
}

// -----------------------------------------------------------------------------
// Type Transformations (snake_case <-> camelCase)
// -----------------------------------------------------------------------------

/**
 * Safely parse a numeric value that may come as string from Django DecimalField (Issue #3)
 * Returns the defaultValue (default: 0) if the value is null, undefined, or cannot be parsed.
 */
function safeParseNumber(value: unknown, defaultValue: number = 0): number {
  if (value === null || value === undefined) return defaultValue;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? defaultValue : parsed;
  }
  return defaultValue;
}

/**
 * Safely parse an optional numeric value (Issue #3)
 * Returns undefined if the value is null, undefined, or cannot be parsed.
 */
function safeParseOptionalNumber(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value === 'number') return value;
  if (typeof value === 'string') {
    const parsed = parseFloat(value);
    return isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
}

/**
 * Transform player data from API (snake_case) to frontend (camelCase)
 */
function transformPlayerFromApi(data: Record<string, unknown>): Player {
  return {
    id: data.id as string,
    // Extract divisionId from API response (Issue #27 - data shape mismatch)
    divisionId: (data.division_id as string | null) ?? undefined,
    bib: data.bib as string,
    firstName: data.first_name as string,
    lastName: data.last_name as string,
    name: data.name as string,
    // Use safe parsing for all numeric fields (Issue #3 - DecimalField may serialize to strings)
    fieldScore: safeParseNumber(data.field_score),
    throwScore: safeParseNumber(data.throw_score),
    hitPower: safeParseNumber(data.hit_power),
    hitForm: safeParseNumber(data.hit_form),
    hitContact: safeParseNumber(data.hit_contact),
    pitchingStrength: safeParseNumber(data.pitching_strength),
    pitchingForm: safeParseNumber(data.pitching_form),
    catchScore: safeParseNumber(data.catch_score),
    runningScore: safeParseNumber(data.running_score),
    fieldingSubtotal: safeParseNumber(data.fielding_subtotal),
    hittingSubtotal: safeParseNumber(data.hitting_subtotal),
    pitchingSubtotal: safeParseNumber(data.pitching_subtotal),
    subjectiveTotal: safeParseNumber(data.subjective_total),
    objectiveTotal: safeParseNumber(data.objective_total),
    officialAdjust: safeParseNumber(data.official_adjust),
    totalScore: safeParseNumber(data.total_score),
    rank: safeParseNumber(data.rank),
    // Use 1 as default for projectedRound to match Django model default (Issue #27)
    projectedRound: safeParseNumber(data.projected_round, 1),
    littleLeagueAge: safeParseNumber(data.little_league_age),
    birthday: data.birthday as string,
    isAllStar: data.is_all_star as boolean,
    isDNE: data.is_dne as boolean,
    isCoachKid: data.is_coach_kid as boolean,
    // Convert null to undefined for optional fields (Issue #8)
    coachTeamId: (data.coach_team_id as string | null) ?? undefined,
    sibling: (data.sibling as string | null) ?? undefined,
    siblingId: (data.sibling_id as string | null) ?? undefined,
    lockedToRound: safeParseOptionalNumber(data.locked_to_round),
    lockedToTeamId: (data.locked_to_team_id as string | null) ?? undefined,
    isDrafted: data.is_drafted as boolean,
    draftedByTeamId: (data.drafted_by_team_id as string | null) ?? undefined,
    draftedInRound: safeParseOptionalNumber(data.drafted_in_round),
    draftedAtPick: safeParseOptionalNumber(data.drafted_at_pick),
  };
}

/**
 * Transform player data from frontend (camelCase) to API (snake_case)
 */
function transformPlayerToApi(player: Partial<Player>): Record<string, unknown> {
  const result: Record<string, unknown> = {};

  // Include id for sibling reference mapping during bulk create
  if (player.id !== undefined) result.id = player.id;
  if (player.bib !== undefined) result.bib = player.bib;
  if (player.firstName !== undefined) result.first_name = player.firstName;
  if (player.lastName !== undefined) result.last_name = player.lastName;
  if (player.fieldScore !== undefined) result.field_score = player.fieldScore;
  if (player.throwScore !== undefined) result.throw_score = player.throwScore;
  if (player.hitPower !== undefined) result.hit_power = player.hitPower;
  if (player.hitForm !== undefined) result.hit_form = player.hitForm;
  if (player.hitContact !== undefined) result.hit_contact = player.hitContact;
  if (player.pitchingStrength !== undefined) result.pitching_strength = player.pitchingStrength;
  if (player.pitchingForm !== undefined) result.pitching_form = player.pitchingForm;
  if (player.catchScore !== undefined) result.catch_score = player.catchScore;
  if (player.runningScore !== undefined) result.running_score = player.runningScore;
  if (player.fieldingSubtotal !== undefined) result.fielding_subtotal = player.fieldingSubtotal;
  if (player.hittingSubtotal !== undefined) result.hitting_subtotal = player.hittingSubtotal;
  if (player.pitchingSubtotal !== undefined) result.pitching_subtotal = player.pitchingSubtotal;
  if (player.subjectiveTotal !== undefined) result.subjective_total = player.subjectiveTotal;
  if (player.objectiveTotal !== undefined) result.objective_total = player.objectiveTotal;
  if (player.officialAdjust !== undefined) result.official_adjust = player.officialAdjust;
  if (player.totalScore !== undefined) result.total_score = player.totalScore;
  if (player.rank !== undefined) result.rank = player.rank;
  if (player.projectedRound !== undefined) result.projected_round = player.projectedRound;
  if (player.littleLeagueAge !== undefined) result.little_league_age = player.littleLeagueAge;
  if (player.birthday !== undefined) result.birthday = player.birthday;
  if (player.isAllStar !== undefined) result.is_all_star = player.isAllStar;
  if (player.isDNE !== undefined) result.is_dne = player.isDNE;
  if (player.isCoachKid !== undefined) result.is_coach_kid = player.isCoachKid;
  if (player.coachTeamId !== undefined) result.coach_team_id = player.coachTeamId;
  if (player.sibling !== undefined) result.sibling = player.sibling;
  if (player.siblingId !== undefined) result.sibling_id = player.siblingId;
  if (player.lockedToRound !== undefined) result.locked_to_round = player.lockedToRound;
  if (player.lockedToTeamId !== undefined) result.locked_to_team_id = player.lockedToTeamId;
  if (player.isDrafted !== undefined) result.is_drafted = player.isDrafted;
  if (player.draftedByTeamId !== undefined) result.drafted_by_team_id = player.draftedByTeamId;
  if (player.draftedInRound !== undefined) result.drafted_in_round = player.draftedInRound;
  if (player.draftedAtPick !== undefined) result.drafted_at_pick = player.draftedAtPick;

  return result;
}

/**
 * Transform team data from API to frontend
 */
function transformTeamFromApi(data: Record<string, unknown>): Team {
  const roster = (data.roster as Record<string, unknown>[] || []).map(transformPlayerFromApi);
  const coachKidsData = data.coach_kids as Record<string, unknown>[] || [];
  // Validate coach_kids array has valid player objects with id field (Issue #18)
  const coachKids = coachKidsData
    .filter((p) => p && typeof p.id === 'string')
    .map((p) => p.id as string);

  return {
    id: data.id as string,
    // Extract divisionId from API response (Issue #27 - data shape mismatch)
    divisionId: (data.division_id as string | null) ?? undefined,
    // Map backend 'name' to frontend 'teamName' (actual team name like "Guardians")
    teamName: (data.name as string) || '',
    headCoach: (data.head_coach as string) || '',
    assistantCoach: (data.assistant_coach as string) || '',
    roster,
    // Use safe parsing for numeric fields (Issue #3)
    totalScore: safeParseNumber(data.total_score),
    draftPosition: safeParseNumber(data.draft_position),
    coachKids,
    ageBreakdown: data.age_breakdown as Record<string, number> || {},
  };
}

/**
 * Transform draft pick from API to frontend
 */
function transformDraftPickFromApi(data: Record<string, unknown>): DraftPick {
  return {
    round: safeParseNumber(data.round),
    pick: safeParseNumber(data.pick),
    teamId: data.team_id as string,
    // Convert null to undefined (Issue #8)
    playerId: (data.player_id as string | null) ?? undefined,
    // Safe timestamp parsing (Issue #15)
    timestamp: data.timestamp ? new Date(data.timestamp as string).getTime() : undefined,
    wasSkipped: data.was_skipped as boolean,
  };
}

/**
 * Transform trade from API to frontend
 */
function transformTradeFromApi(data: Record<string, unknown>): Trade {
  return {
    id: data.id as string,
    timestamp: new Date(data.timestamp as string).getTime(),
    team1Id: data.team1_id as string,
    team2Id: data.team2_id as string,
    player1Id: data.player1_id as string,
    player2Id: data.player2_id as string,
    reason: data.reason as string,
  };
}

/**
 * Transform draft state from API to frontend
 */
function transformDraftStateFromApi(
  data: Record<string, unknown>,
  players: Player[],
  teams: Team[]
): DraftState {
  const picks = (data.picks as Record<string, unknown>[] || []).map(transformDraftPickFromApi);
  const trades = (data.trades as Record<string, unknown>[] || []).map(transformTradeFromApi);

  let mandatoryPick: DraftState['mandatoryPick'] = undefined;
  const mandatoryPickData = data.mandatory_pick as Record<string, unknown> | null;
  if (mandatoryPickData) {
    mandatoryPick = {
      playerId: mandatoryPickData.player_id as string,
      reason: mandatoryPickData.reason as 'coach-kid' | 'sibling',
      // Convert null to undefined (Issue #8)
      siblingName: (mandatoryPickData.sibling_name as string | null) ?? undefined,
    };
  }

  return {
    // Convert null to undefined (Issue #8)
    id: (data.id as string | null) ?? undefined,
    // Extract divisionId from API response (Issue #27 - data shape mismatch)
    divisionId: (data.division_id as string | null) ?? undefined,
    players,
    teams,
    draftFormat: data.draft_format as DraftFormat,
    draftOrder: data.draft_order as string[] || [],
    currentRoundOrder: data.current_round_order as string[] || [],
    picks,
    // Use safe parsing for numeric fields (Issue #3)
    currentRound: safeParseNumber(data.current_round),
    currentPickInRound: safeParseNumber(data.current_pick_in_round),
    currentTeamId: (data.current_team_id as string | null) ?? null,
    isDraftComplete: data.is_draft_complete as boolean,
    mandatoryPick,
    trades,
  };
}

/**
 * Transform division data from API to frontend
 */
function transformDivisionFromApi(data: Record<string, unknown>): Division {
  const players = (data.players as Record<string, unknown>[] || []).map(transformPlayerFromApi);
  const teams = (data.teams as Record<string, unknown>[] || []).map(transformTeamFromApi);
  const ageRange = data.age_range as { min: number; max: number };

  let draftState: DraftState | null = null;
  const draftStateData = data.draft_state as Record<string, unknown> | null;
  if (draftStateData) {
    draftState = transformDraftStateFromApi(draftStateData, players, teams);
  }

  return {
    id: data.id as string,
    name: data.name as string,
    preset: data.preset as DivisionPreset,
    mode: (data.mode as Division['mode']) || 'live-draft',
    ageRange: ageRange,
    enforceAgeLimit: data.enforce_age_limit as boolean,
    // Use safe parsing for numeric fields (Issue #3)
    maxPerAge: safeParseNumber(data.max_per_age),
    teamCount: safeParseNumber(data.team_count),
    rosterSize: safeParseNumber(data.roster_size),
    teams,
    players,
    draftState,
    scoringWeights: data.scoring_weights as ScoringWeights,
    scoringMode: data.scoring_mode as ScoringMode,
    phase: data.phase as Division['phase'],
    createdAt: data.created_at as string,
    // Extract updatedAt from API response (Issue #27 - data shape mismatch)
    updatedAt: (data.updated_at as string | null) ?? undefined,
    // Convert null to undefined (Issue #8)
    completedAt: (data.completed_at as string | null) ?? undefined,
    // Organization/personal workspace fields
    organizationId: (data.organization_id as string | null) ?? undefined,
    ownerId: (data.owner_id as string | null) ?? undefined,
    isPersonal: data.is_personal as boolean ?? true,
  };
}

/**
 * Transform organization membership from API to frontend
 */
function transformOrganizationMembershipFromApi(data: Record<string, unknown>): import('../types').OrganizationMembership {
  return {
    id: data.id as string,
    // New organization fields
    organizationId: (data.organization_id || data.league_id) as string,
    organizationName: (data.organization_name || data.league_name) as string,
    organizationSlug: (data.organization_slug || data.league_slug) as string,
    role: data.role as import('../types').OrganizationMembershipRole,
    createdAt: data.created_at as string,
    // Legacy aliases for backwards compatibility
    leagueId: (data.organization_id || data.league_id) as string,
    leagueName: (data.organization_name || data.league_name) as string,
    leagueSlug: (data.organization_slug || data.league_slug) as string,
  };
}

// Legacy alias (exported for backwards compatibility)
export const transformLeagueMembershipFromApi = transformOrganizationMembershipFromApi;

/**
 * Transform user data from API to frontend
 */
function transformUserFromApi(data: Record<string, unknown>): User {
  // Support both organizations and leagues (backwards compat)
  const memberships = (data.organizations as Record<string, unknown>[] || data.leagues as Record<string, unknown>[] || [])
    .map(transformOrganizationMembershipFromApi);
  return {
    id: data.id as string,
    email: data.email as string,
    firstName: data.first_name as string,
    lastName: data.last_name as string,
    role: data.role as User['role'],
    organizations: memberships,
    leagues: memberships, // Legacy alias
  };
}

/**
 * Transform division summary from API to frontend
 */
function transformDivisionSummaryFromApi(data: Record<string, unknown>): DivisionSummary {
  return {
    id: data.id as string,
    name: data.name as string,
    preset: data.preset as DivisionPreset,
    mode: (data.mode as DivisionSummary['mode']) || 'live-draft',
    // Use safe parsing for numeric fields (Issue #3)
    teamCount: safeParseNumber(data.team_count),
    playerCount: safeParseNumber(data.player_count),
    phase: data.phase as DivisionSummary['phase'],
    createdAt: data.created_at as string,
    // Convert null to undefined (Issue #8)
    completedAt: (data.completed_at as string | null) ?? undefined,
    // Organization/personal workspace fields
    organizationId: (data.organization_id as string | null) ?? undefined,
    ownerId: (data.owner_id as string | null) ?? undefined,
    isPersonal: data.is_personal as boolean ?? true,
  };
}

// -----------------------------------------------------------------------------
// Evaluation Template Transformations
// -----------------------------------------------------------------------------

/**
 * Transform evaluation template data from API (snake_case) to frontend (camelCase)
 */
function transformTemplateFromApi(data: Record<string, unknown>): EvaluationTemplate {
  return {
    id: data.id as string,
    organizationId: data.organization_id as string,
    name: data.name as string,
    description: (data.description as string) || '',
    version: data.version as number,
    parentTemplateId: (data.parent_template_id as string | null) ?? null,
    stations: (data.stations as EvaluationTemplate['stations']) || [],
    coachCategories: (data.coach_categories as EvaluationTemplate['coachCategories']) || [],
    blendWeights: (data.blend_weights as EvaluationTemplate['blendWeights']) || { coachRating: 40, tryoutScore: 60 },
    isActive: data.is_active as boolean,
    isLocked: data.is_locked as boolean,
    createdById: (data.created_by_id as string | null) ?? null,
    createdAt: data.created_at as string,
    updatedAt: data.updated_at as string,
  };
}

/**
 * Transform template data from frontend (camelCase) to API (snake_case)
 */
function transformTemplateToApi(data: Partial<CreateTemplateData>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (data.name !== undefined) result.name = data.name;
  if (data.description !== undefined) result.description = data.description;
  if (data.stations !== undefined) result.stations = data.stations;
  if (data.coachCategories !== undefined) result.coach_categories = data.coachCategories;
  if (data.blendWeights !== undefined) result.blend_weights = data.blendWeights;
  return result;
}

/**
 * Transform season data from API (snake_case) to frontend (camelCase)
 */
function transformSeasonFromApi(data: Record<string, unknown>): Season {
  return {
    id: data.id as string,
    organizationId: data.organization_id as string,
    name: data.name as string,
    year: data.year as number,
    templateId: data.template_id as string,
    isActive: data.is_active as boolean,
    createdAt: data.created_at as string,
    updatedAt: data.updated_at as string,
  };
}

/**
 * Transform season data from frontend (camelCase) to API (snake_case)
 */
function transformSeasonToApi(data: Partial<CreateSeasonData>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  if (data.name !== undefined) result.name = data.name;
  if (data.year !== undefined) result.year = data.year;
  if (data.templateId !== undefined) result.template_id = data.templateId;
  return result;
}

// -----------------------------------------------------------------------------
// API Error Handling
// -----------------------------------------------------------------------------

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public details?: Record<string, unknown>
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

// Global callback for session expiry - set by AuthContext (Issue #4)
let onSessionExpired: (() => void) | null = null;

/**
 * Register a callback to be called when the session expires (401 error).
 * This is used by AuthContext to trigger logout and redirect to login.
 */
export function setSessionExpiredCallback(callback: (() => void) | null): void {
  onSessionExpired = callback;
}

// Track if we're currently refreshing CSRF token to avoid loops (Issue #9)
let isRefreshingCSRF = false;

/**
 * Refresh CSRF token by calling the CSRF endpoint.
 * Returns true if refresh was successful.
 */
async function refreshCSRFToken(): Promise<boolean> {
  if (isRefreshingCSRF) return false;

  isRefreshingCSRF = true;
  try {
    await fetch(`${API_BASE_URL}/auth/csrf/`, {
      credentials: 'include',
    });
    return true;
  } catch {
    return false;
  } finally {
    isRefreshingCSRF = false;
  }
}

/**
 * Execute a fetch request with automatic CSRF token refresh on 403.
 * Will retry once after refreshing the CSRF token.
 */
async function fetchWithCSRFRetry(
  url: string,
  options: RequestInit,
  useTimeout: boolean = false,
  timeoutMs: number = DEFAULT_TIMEOUT_MS
): Promise<Response> {
  const doFetch = useTimeout
    ? () => fetchWithTimeout(url, options, timeoutMs)
    : () => fetch(url, options);

  const response = await doFetch();

  // Check for CSRF error (403 with specific message)
  if (response.status === 403 && !isRefreshingCSRF) {
    // Clone the response to read the body without consuming it
    const clonedResponse = response.clone();
    try {
      const contentType = clonedResponse.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        const details = await clonedResponse.json();
        const isCSRFError =
          details?.detail === 'CSRF Failed: CSRF token missing or incorrect.' ||
          details?.detail?.includes('CSRF');

        if (isCSRFError) {
          console.warn('CSRF token expired, refreshing and retrying request...');
          const refreshed = await refreshCSRFToken();
          if (refreshed) {
            // Get fresh CSRF token for retry
            const csrfToken = getCSRFToken();
            if (csrfToken && options.headers) {
              (options.headers as Record<string, string>)['X-CSRFToken'] = csrfToken;
            }
            // Retry the request once
            return doFetch();
          }
        }
      }
    } catch {
      // Failed to parse response, continue with original response
    }
  }

  return response;
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    let details: Record<string, unknown> | undefined;

    // Try to parse JSON error details, handle non-JSON responses gracefully (Issue #24)
    const contentType = response.headers.get('content-type');
    if (contentType && contentType.includes('application/json')) {
      try {
        details = await response.json();
      } catch {
        // Response body might not be valid JSON
      }
    } else {
      // Non-JSON response (e.g., HTML from nginx 5xx error)
      try {
        const text = await response.text();
        details = { rawResponse: text.substring(0, 500) }; // Truncate to avoid huge error messages
      } catch {
        // Couldn't read response
      }
    }

    // Handle 401 Unauthorized - session expired (Issue #4)
    if (response.status === 401 && onSessionExpired) {
      // Don't trigger logout for auth endpoints (login/register) - those expect 401 for invalid credentials
      const isAuthEndpoint = response.url.includes('/auth/login') || response.url.includes('/auth/register');
      if (!isAuthEndpoint) {
        console.warn('Session expired (401), triggering logout');
        onSessionExpired();
      }
    }

    // Note: CSRF 403 errors are now handled in fetchWithCSRFRetry with automatic retry

    throw new ApiError(
      `API request failed: ${response.statusText}`,
      response.status,
      details
    );
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return undefined as T;
  }

  // Handle JSON parsing errors gracefully (Issue #24)
  try {
    return await response.json();
  } catch {
    throw new ApiError(
      'Failed to parse API response as JSON',
      response.status,
      { parseError: true }
    );
  }
}

// -----------------------------------------------------------------------------
// API Client
// -----------------------------------------------------------------------------

export const api = {
  // ---------------------------------------------------------------------------
  // Health Check
  // ---------------------------------------------------------------------------

  async health(): Promise<{ status: string }> {
    const response = await fetch(`${API_BASE_URL.replace('/api', '')}/health`, getDefaultOptions());
    return handleResponse(response);
  },

  // ---------------------------------------------------------------------------
  // CSRF Token
  // ---------------------------------------------------------------------------

  /**
   * Initialize CSRF token cookie.
   * Call this on app initialization to ensure the CSRF cookie is set before any POST requests.
   */
  async initCSRF(): Promise<void> {
    try {
      await fetch(`${API_BASE_URL}/auth/csrf/`, {
        ...getDefaultOptions(),
        credentials: 'include',
      });
    } catch {
      // Silently fail - CSRF cookie might already be set
    }
  },

  // ---------------------------------------------------------------------------
  // Auth
  // ---------------------------------------------------------------------------

  async register(data: RegisterData): Promise<User> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/auth/register/`, {
      ...getDefaultOptions('POST'),
      method: 'POST',
      body: JSON.stringify({
        email: data.email,
        password: data.password,
        first_name: data.firstName || '',
        last_name: data.lastName || '',
        league_name: data.leagueName || '',
        league_slug: data.leagueSlug || '',
      }),
    });
    const result = await handleResponse<Record<string, unknown>>(response);
    return transformUserFromApi(result);
  },

  async login(credentials: LoginCredentials): Promise<User> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/auth/login/`, {
      ...getDefaultOptions('POST'),
      method: 'POST',
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password,
      }),
    });
    const result = await handleResponse<Record<string, unknown>>(response);
    return transformUserFromApi(result);
  },

  async logout(): Promise<void> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/auth/logout/`, {
      ...getDefaultOptions('POST'),
      method: 'POST',
    });
    await handleResponse<void>(response);
  },

  async getCurrentUser(): Promise<User> {
    const response = await fetch(`${API_BASE_URL}/auth/me/`, getDefaultOptions());
    const result = await handleResponse<Record<string, unknown>>(response);
    return transformUserFromApi(result);
  },

  async requestPasswordReset(email: string): Promise<{ message: string }> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/auth/password-reset/`, {
      ...getDefaultOptions('POST'),
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    return handleResponse<{ message: string }>(response);
  },

  async confirmPasswordReset(uid: string, token: string, newPassword: string): Promise<{ message: string }> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/auth/password-reset/confirm/`, {
      ...getDefaultOptions('POST'),
      method: 'POST',
      body: JSON.stringify({
        uid,
        token,
        new_password: newPassword,
      }),
    });
    return handleResponse<{ message: string }>(response);
  },

  // ---------------------------------------------------------------------------
  // Divisions
  // ---------------------------------------------------------------------------

  async listDivisions(): Promise<DivisionSummary[]> {
    const response = await fetch(`${API_BASE_URL}/divisions/`, getDefaultOptions());
    const data = await handleResponse<Record<string, unknown>[]>(response);
    return data.map(transformDivisionSummaryFromApi);
  },

  async getDivision(id: string): Promise<Division> {
    const response = await fetch(`${API_BASE_URL}/divisions/${id}/?include=all`, getDefaultOptions());
    const data = await handleResponse<Record<string, unknown>>(response);
    return transformDivisionFromApi(data);
  },

  async createDivision(params: {
    name: string;
    preset: DivisionPreset;
    mode?: Division['mode'];
    ageRange: DivisionAgeRange;
    teamCount: number;
    enforceAgeLimit?: boolean;
    maxPerAge?: number;
    scoringWeights?: ScoringWeights;
    scoringMode?: ScoringMode;
    coaches?: Array<{ headCoach: string; assistantCoach: string }>;
  }): Promise<Division> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/divisions/`, {
      ...getDefaultOptions('POST'),
      method: 'POST',
      body: JSON.stringify({
        name: params.name,
        preset: params.preset,
        mode: params.mode ?? 'live-draft',
        age_range: params.ageRange,
        team_count: params.teamCount,
        enforce_age_limit: params.enforceAgeLimit ?? true,
        max_per_age: params.maxPerAge ?? 0,
        scoring_weights: params.scoringWeights,
        scoring_mode: params.scoringMode ?? 'pre-weighted',
        coaches: params.coaches,
      }),
    });
    const data = await handleResponse<Record<string, unknown>>(response);
    return transformDivisionFromApi(data);
  },

  async updateDivision(
    id: string,
    updates: Partial<{
      name: string;
      preset: DivisionPreset;
      ageRange: DivisionAgeRange;
      enforceAgeLimit: boolean;
      maxPerAge: number;
      teamCount: number;
      rosterSize: number;
      scoringWeights: ScoringWeights;
      scoringMode: ScoringMode;
      phase: Division['phase'];
    }>
  ): Promise<Division> {
    const body: Record<string, unknown> = {};
    if (updates.name !== undefined) body.name = updates.name;
    if (updates.preset !== undefined) body.preset = updates.preset;
    if (updates.ageRange !== undefined) body.age_range = updates.ageRange;
    if (updates.enforceAgeLimit !== undefined) body.enforce_age_limit = updates.enforceAgeLimit;
    if (updates.maxPerAge !== undefined) body.max_per_age = updates.maxPerAge;
    if (updates.teamCount !== undefined) body.team_count = updates.teamCount;
    if (updates.rosterSize !== undefined) body.roster_size = updates.rosterSize;
    if (updates.scoringWeights !== undefined) body.scoring_weights = updates.scoringWeights;
    if (updates.scoringMode !== undefined) body.scoring_mode = updates.scoringMode;
    if (updates.phase !== undefined) body.phase = updates.phase;

    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/divisions/${id}/`, {
      ...getDefaultOptions('PATCH'),
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    const data = await handleResponse<Record<string, unknown>>(response);
    return transformDivisionFromApi(data);
  },

  async deleteDivision(id: string): Promise<void> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/divisions/${id}/`, {
      ...getDefaultOptions('DELETE'),
      method: 'DELETE',
    });
    await handleResponse<void>(response);
  },

  // ---------------------------------------------------------------------------
  // Players
  // ---------------------------------------------------------------------------

  async getPlayer(id: string): Promise<Player> {
    const response = await fetch(`${API_BASE_URL}/players/${id}/`, getDefaultOptions());
    const data = await handleResponse<Record<string, unknown>>(response);
    return transformPlayerFromApi(data);
  },

  async updatePlayer(id: string, updates: Partial<Player>): Promise<Player> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/players/${id}/`, {
      ...getDefaultOptions('PATCH'),
      method: 'PATCH',
      body: JSON.stringify(transformPlayerToApi(updates)),
    });
    const data = await handleResponse<Record<string, unknown>>(response);
    return transformPlayerFromApi(data);
  },

  async deletePlayer(id: string): Promise<void> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/players/${id}/`, {
      ...getDefaultOptions('DELETE'),
      method: 'DELETE',
    });
    await handleResponse<void>(response);
  },

  async bulkCreatePlayers(divisionId: string, players: Partial<Player>[]): Promise<Player[]> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/players/bulk/`, {
      ...getDefaultOptions('POST'),
      method: 'POST',
      body: JSON.stringify({
        division_id: divisionId,
        players: players.map(transformPlayerToApi),
      }),
    }, true); // Use timeout for bulk operations
    const data = await handleResponse<Record<string, unknown>[]>(response);
    return data.map(transformPlayerFromApi);
  },

  async deleteAllPlayers(divisionId: string): Promise<{ deleted: number }> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/players/delete_by_division/?division_id=${divisionId}`, {
      ...getDefaultOptions('DELETE'),
      method: 'DELETE',
    });
    return handleResponse<{ deleted: number }>(response);
  },

  // ---------------------------------------------------------------------------
  // Teams
  // ---------------------------------------------------------------------------

  async getTeam(id: string): Promise<Team> {
    const response = await fetch(`${API_BASE_URL}/teams/${id}/`, getDefaultOptions());
    const data = await handleResponse<Record<string, unknown>>(response);
    return transformTeamFromApi(data);
  },

  async updateTeam(
    id: string,
    updates: Partial<{
      teamName: string;  // Maps to backend 'name' field
      headCoach: string;
      assistantCoach: string;
      draftPosition: number;
      totalScore: number;
      ageBreakdown: Record<string, number>;
    }>
  ): Promise<Team> {
    const body: Record<string, unknown> = {};
    // Map frontend 'teamName' to backend 'name'
    if (updates.teamName !== undefined) body.name = updates.teamName;
    if (updates.headCoach !== undefined) body.head_coach = updates.headCoach;
    if (updates.assistantCoach !== undefined) body.assistant_coach = updates.assistantCoach;
    if (updates.draftPosition !== undefined) body.draft_position = updates.draftPosition;
    if (updates.totalScore !== undefined) body.total_score = updates.totalScore;
    if (updates.ageBreakdown !== undefined) body.age_breakdown = updates.ageBreakdown;

    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/teams/${id}/`, {
      ...getDefaultOptions('PATCH'),
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    const data = await handleResponse<Record<string, unknown>>(response);
    return transformTeamFromApi(data);
  },

  async listTeams(divisionId: string): Promise<Team[]> {
    const response = await fetch(`${API_BASE_URL}/teams/?division_id=${divisionId}`, getDefaultOptions());
    const data = await handleResponse<Record<string, unknown>[]>(response);
    return data.map(transformTeamFromApi);
  },

  // ---------------------------------------------------------------------------
  // Draft Operations
  // ---------------------------------------------------------------------------

  async startDraft(params: {
    divisionId: string;
    draftFormat: DraftFormat;
    draftOrder: string[];
  }): Promise<{ draftState: DraftState; players: Player[]; teams: Team[] }> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/draft/start/`, {
      ...getDefaultOptions('POST'),
      method: 'POST',
      body: JSON.stringify({
        division_id: params.divisionId,
        draft_format: params.draftFormat,
        draft_order: params.draftOrder,
      }),
    }, true); // Use timeout for draft operations
    const data = await handleResponse<Record<string, unknown>>(response);

    const players = (data.players as Record<string, unknown>[]).map(transformPlayerFromApi);
    const teams = (data.teams as Record<string, unknown>[]).map(transformTeamFromApi);
    const draftState = transformDraftStateFromApi(
      data.draft_state as Record<string, unknown>,
      players,
      teams
    );

    return { draftState, players, teams };
  },

  async draftPlayer(params: {
    draftStateId: string;
    playerId: string;
    teamId: string;
  }): Promise<{ draftState: DraftState; players: Player[]; teams: Team[] }> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/draft/pick/`, {
      ...getDefaultOptions('POST'),
      method: 'POST',
      body: JSON.stringify({
        draft_state_id: params.draftStateId,
        player_id: params.playerId,
        team_id: params.teamId,
      }),
    }, true); // Use timeout for draft operations
    const data = await handleResponse<Record<string, unknown>>(response);

    const players = (data.players as Record<string, unknown>[]).map(transformPlayerFromApi);
    const teams = (data.teams as Record<string, unknown>[]).map(transformTeamFromApi);
    const draftState = transformDraftStateFromApi(
      data.draft_state as Record<string, unknown>,
      players,
      teams
    );

    return { draftState, players, teams };
  },

  async undoLastPick(draftStateId: string): Promise<{ draftState: DraftState; players: Player[]; teams: Team[] }> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/draft/undo/`, {
      ...getDefaultOptions('POST'),
      method: 'POST',
      body: JSON.stringify({
        draft_state_id: draftStateId,
      }),
    }, true); // Use timeout for draft operations
    const data = await handleResponse<Record<string, unknown>>(response);

    const players = (data.players as Record<string, unknown>[]).map(transformPlayerFromApi);
    const teams = (data.teams as Record<string, unknown>[]).map(transformTeamFromApi);
    const draftState = transformDraftStateFromApi(
      data.draft_state as Record<string, unknown>,
      players,
      teams
    );

    return { draftState, players, teams };
  },

  async skipPick(params: {
    draftStateId: string;
    teamId: string;
  }): Promise<{ draftState: DraftState; players: Player[]; teams: Team[] }> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/draft/skip/`, {
      ...getDefaultOptions('POST'),
      method: 'POST',
      body: JSON.stringify({
        draft_state_id: params.draftStateId,
        team_id: params.teamId,
      }),
    }, true); // Use timeout for draft operations
    const data = await handleResponse<Record<string, unknown>>(response);

    const players = (data.players as Record<string, unknown>[]).map(transformPlayerFromApi);
    const teams = (data.teams as Record<string, unknown>[]).map(transformTeamFromApi);
    const draftState = transformDraftStateFromApi(
      data.draft_state as Record<string, unknown>,
      players,
      teams
    );

    return { draftState, players, teams };
  },

  async createTrade(params: {
    draftStateId: string;
    team1Id: string;
    team2Id: string;
    player1Id: string;
    player2Id: string;
    reason: string;
  }): Promise<{ draftState: DraftState; players: Player[]; teams: Team[] }> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/draft/trade/`, {
      ...getDefaultOptions('POST'),
      method: 'POST',
      body: JSON.stringify({
        draft_state_id: params.draftStateId,
        team1_id: params.team1Id,
        team2_id: params.team2Id,
        player1_id: params.player1Id,
        player2_id: params.player2Id,
        reason: params.reason,
      }),
    }, true); // Use timeout for draft operations
    const data = await handleResponse<Record<string, unknown>>(response);

    const players = (data.players as Record<string, unknown>[]).map(transformPlayerFromApi);
    const teams = (data.teams as Record<string, unknown>[]).map(transformTeamFromApi);
    const draftState = transformDraftStateFromApi(
      data.draft_state as Record<string, unknown>,
      players,
      teams
    );

    return { draftState, players, teams };
  },

  async resetDraft(divisionId: string): Promise<Division> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/divisions/${divisionId}/reset/`, {
      ...getDefaultOptions('POST'),
      method: 'POST',
    });
    const data = await handleResponse<Record<string, unknown>>(response);
    return transformDivisionFromApi(data);
  },

  // ---------------------------------------------------------------------------
  // Profile
  // ---------------------------------------------------------------------------

  async updateProfile(data: ProfileUpdateData): Promise<User> {
    const body: Record<string, unknown> = {};
    if (data.firstName !== undefined) body.first_name = data.firstName;
    if (data.lastName !== undefined) body.last_name = data.lastName;

    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/auth/me/`, {
      ...getDefaultOptions('PATCH'),
      method: 'PATCH',
      body: JSON.stringify(body),
    });
    const result = await handleResponse<Record<string, unknown>>(response);
    return transformUserFromApi(result);
  },

  async changePassword(data: ChangePasswordData): Promise<{ message: string }> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/auth/change-password/`, {
      ...getDefaultOptions('POST'),
      method: 'POST',
      body: JSON.stringify({
        current_password: data.currentPassword,
        new_password: data.newPassword,
      }),
    });
    return handleResponse<{ message: string }>(response);
  },

  // ---------------------------------------------------------------------------
  // League Members
  // ---------------------------------------------------------------------------

  async listLeagueMembers(leagueId: string): Promise<LeagueMember[]> {
    const response = await fetch(`${API_BASE_URL}/leagues/${leagueId}/members/`, getDefaultOptions());
    const data = await handleResponse<Record<string, unknown>[]>(response);
    return data.map(transformLeagueMemberFromApi);
  },

  async removeLeagueMember(leagueId: string, userId: string): Promise<void> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/leagues/${leagueId}/members/${userId}/`, {
      ...getDefaultOptions('DELETE'),
      method: 'DELETE',
    });
    await handleResponse<void>(response);
  },

  async updateMemberRole(leagueId: string, userId: string, role: LeagueMembershipRole): Promise<LeagueMember> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/leagues/${leagueId}/members/${userId}/role/`, {
      ...getDefaultOptions('PATCH'),
      method: 'PATCH',
      body: JSON.stringify({ role }),
    });
    const data = await handleResponse<Record<string, unknown>>(response);
    return transformLeagueMemberFromApi(data);
  },

  // ---------------------------------------------------------------------------
  // League Invitations
  // ---------------------------------------------------------------------------

  async listLeagueInvitations(leagueId: string): Promise<LeagueInvitation[]> {
    const response = await fetch(`${API_BASE_URL}/leagues/${leagueId}/invitations/`, getDefaultOptions());
    const data = await handleResponse<Record<string, unknown>[]>(response);
    return data.map(transformLeagueInvitationFromApi);
  },

  async createInvitation(leagueId: string, email: string, role: OrganizationMembershipRole = 'viewer'): Promise<LeagueInvitation> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/leagues/${leagueId}/invitations/`, {
      ...getDefaultOptions('POST'),
      method: 'POST',
      body: JSON.stringify({ email, role }),
    });
    const data = await handleResponse<Record<string, unknown>>(response);
    return transformLeagueInvitationFromApi(data);
  },

  async cancelInvitation(leagueId: string, invitationId: string): Promise<void> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/leagues/${leagueId}/invitations/${invitationId}/`, {
      ...getDefaultOptions('DELETE'),
      method: 'DELETE',
    });
    await handleResponse<void>(response);
  },

  async acceptInvitation(token: string): Promise<AcceptInvitationResult> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/invitations/accept/`, {
      ...getDefaultOptions('POST'),
      method: 'POST',
      body: JSON.stringify({ token }),
    });
    const data = await handleResponse<Record<string, unknown>>(response);
    const orgId = (data.organization_id || data.league_id) as string;
    const orgName = (data.organization_name || data.league_name) as string;
    return {
      message: data.message as string,
      organizationId: orgId,
      organizationName: orgName,
      // Legacy aliases
      leagueId: orgId,
      leagueName: orgName,
    };
  },

  // ---------------------------------------------------------------------------
  // Join Link
  // ---------------------------------------------------------------------------

  async getJoinLinkStatus(leagueId: string): Promise<JoinLinkStatus> {
    const response = await fetch(`${API_BASE_URL}/leagues/${leagueId}/join-link/`, getDefaultOptions());
    const data = await handleResponse<Record<string, unknown>>(response);
    return {
      enabled: data.enabled as boolean,
      token: data.token as string | null,
      url: data.url as string | null,
    };
  },

  async generateJoinLink(leagueId: string): Promise<JoinLinkStatus> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/leagues/${leagueId}/join-link/`, {
      ...getDefaultOptions('POST'),
      method: 'POST',
    });
    const data = await handleResponse<Record<string, unknown>>(response);
    return {
      enabled: data.enabled as boolean,
      token: data.token as string | null,
      url: data.url as string | null,
    };
  },

  async disableJoinLink(leagueId: string): Promise<JoinLinkStatus> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/leagues/${leagueId}/join-link/`, {
      ...getDefaultOptions('DELETE'),
      method: 'DELETE',
    });
    const data = await handleResponse<Record<string, unknown>>(response);
    return {
      enabled: data.enabled as boolean,
      token: data.token as string | null,
      url: data.url as string | null,
    };
  },

  async getJoinLinkInfo(token: string): Promise<JoinLinkInfo> {
    const response = await fetch(`${API_BASE_URL}/leagues/join/${token}/`, getDefaultOptions());
    const data = await handleResponse<Record<string, unknown>>(response);
    const orgName = (data.organization_name || data.league_name) as string;
    const orgSlug = (data.organization_slug || data.league_slug) as string;
    return {
      organizationName: orgName,
      organizationSlug: orgSlug,
      type: data.type as 'join_link' | 'email_invitation' | undefined,
      invitedBy: data.invited_by as string | null | undefined,
      role: data.role as OrganizationMembershipRole | undefined,
      // Legacy aliases
      leagueName: orgName,
      leagueSlug: orgSlug,
    };
  },

  // ---------------------------------------------------------------------------
  // Evaluation Templates
  // ---------------------------------------------------------------------------

  async listEvaluationTemplates(): Promise<EvaluationTemplate[]> {
    const response = await fetch(`${API_BASE_URL}/evaluation-templates/`, getDefaultOptions());
    const data = await handleResponse<Record<string, unknown>[]>(response);
    return data.map(transformTemplateFromApi);
  },

  async getEvaluationTemplate(id: string): Promise<EvaluationTemplate> {
    const response = await fetch(`${API_BASE_URL}/evaluation-templates/${id}/`, getDefaultOptions());
    const data = await handleResponse<Record<string, unknown>>(response);
    return transformTemplateFromApi(data);
  },

  async createEvaluationTemplate(templateData: CreateTemplateData): Promise<EvaluationTemplate> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/evaluation-templates/`, {
      ...getDefaultOptions('POST'),
      method: 'POST',
      body: JSON.stringify(transformTemplateToApi(templateData)),
    });
    const data = await handleResponse<Record<string, unknown>>(response);
    return transformTemplateFromApi(data);
  },

  async updateEvaluationTemplate(id: string, templateData: Partial<CreateTemplateData>): Promise<EvaluationTemplate> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/evaluation-templates/${id}/`, {
      ...getDefaultOptions('PATCH'),
      method: 'PATCH',
      body: JSON.stringify(transformTemplateToApi(templateData)),
    });
    const data = await handleResponse<Record<string, unknown>>(response);
    return transformTemplateFromApi(data);
  },

  async deleteEvaluationTemplate(id: string): Promise<void> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/evaluation-templates/${id}/`, {
      ...getDefaultOptions('DELETE'),
      method: 'DELETE',
    });
    await handleResponse<void>(response);
  },

  // ---------------------------------------------------------------------------
  // Seasons
  // ---------------------------------------------------------------------------

  async listSeasons(): Promise<Season[]> {
    const response = await fetch(`${API_BASE_URL}/seasons/`, getDefaultOptions());
    const data = await handleResponse<Record<string, unknown>[]>(response);
    return data.map(transformSeasonFromApi);
  },

  async createSeason(seasonData: CreateSeasonData): Promise<Season> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/seasons/`, {
      ...getDefaultOptions('POST'),
      method: 'POST',
      body: JSON.stringify(transformSeasonToApi(seasonData)),
    });
    const data = await handleResponse<Record<string, unknown>>(response);
    return transformSeasonFromApi(data);
  },

  async updateSeason(id: string, seasonData: Partial<CreateSeasonData>): Promise<Season> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/seasons/${id}/`, {
      ...getDefaultOptions('PATCH'),
      method: 'PATCH',
      body: JSON.stringify(transformSeasonToApi(seasonData)),
    });
    const data = await handleResponse<Record<string, unknown>>(response);
    return transformSeasonFromApi(data);
  },

  async deleteSeason(id: string): Promise<void> {
    const response = await fetchWithCSRFRetry(`${API_BASE_URL}/seasons/${id}/`, {
      ...getDefaultOptions('DELETE'),
      method: 'DELETE',
    });
    await handleResponse<void>(response);
  },
};

// Transform league member from API
function transformLeagueMemberFromApi(data: Record<string, unknown>): LeagueMember {
  return {
    id: data.id as string,
    userId: data.user_id as string,
    email: data.email as string,
    firstName: data.first_name as string,
    lastName: data.last_name as string,
    role: data.role as LeagueMembershipRole,
    joinedAt: data.joined_at as string,
  };
}

// Transform league invitation from API
function transformLeagueInvitationFromApi(data: Record<string, unknown>): LeagueInvitation {
  return {
    id: data.id as string,
    email: data.email as string | null,
    role: data.role as LeagueMembershipRole,
    invitedByEmail: data.invited_by_email as string,
    isLinkInvite: data.is_link_invite as boolean,
    createdAt: data.created_at as string,
    expiresAt: data.expires_at as string,
    acceptedAt: data.accepted_at as string | null,
    isExpired: data.is_expired as boolean,
    isPending: data.is_pending as boolean,
  };
}

export default api;
