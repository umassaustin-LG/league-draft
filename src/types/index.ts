// -----------------------------------------------------------------------------
// Auth Types
// -----------------------------------------------------------------------------

export type UserRole = 'master_admin' | 'user';

// Organization membership roles (coach can view draft, viewer is read-only)
export type OrganizationMembershipRole = 'admin' | 'coach' | 'viewer';

// Legacy alias for backwards compatibility
export type LeagueMembershipRole = OrganizationMembershipRole;

export interface OrganizationMembership {
  id: string;
  organizationId: string;
  organizationName: string;
  organizationSlug: string;
  role: OrganizationMembershipRole;
  createdAt: string;
  // Legacy aliases for backwards compatibility
  leagueId: string;
  leagueName: string;
  leagueSlug: string;
}

// Legacy alias
export type LeagueMembership = OrganizationMembership;

export interface User {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
  role: UserRole;
  organizations: OrganizationMembership[];
  // Legacy alias for backwards compatibility
  leagues: OrganizationMembership[];
}

export interface Organization {
  id: string;
  name: string;
  slug: string;
  createdAt: string;
}

// Legacy alias
export type League = Organization;

export interface LoginCredentials {
  email: string;
  password: string;
}

export interface RegisterData {
  email: string;
  password: string;
  firstName?: string;
  lastName?: string;
  organizationName?: string;
  organizationSlug?: string;
  // Legacy aliases
  leagueName?: string;
  leagueSlug?: string;
}

export interface ProfileUpdateData {
  firstName?: string;
  lastName?: string;
}

export interface ChangePasswordData {
  currentPassword: string;
  newPassword: string;
}

// -----------------------------------------------------------------------------
// Organization Member Types
// -----------------------------------------------------------------------------

export interface OrganizationMember {
  id: string;
  userId: string;
  email: string;
  firstName: string;
  lastName: string;
  role: OrganizationMembershipRole;
  joinedAt: string;
}

// Legacy alias
export type LeagueMember = OrganizationMember;

export interface OrganizationInvitation {
  id: string;
  email: string | null;
  role: OrganizationMembershipRole;
  invitedByEmail: string;
  isLinkInvite: boolean;
  createdAt: string;
  expiresAt: string;
  acceptedAt: string | null;
  isExpired: boolean;
  isPending: boolean;
}

// Legacy alias
export type LeagueInvitation = OrganizationInvitation;

export interface JoinLinkStatus {
  enabled: boolean;
  token: string | null;
  url: string | null;
}

export interface JoinLinkInfo {
  organizationName: string;
  organizationSlug: string;
  type?: 'join_link' | 'email_invitation';
  invitedBy?: string | null;
  role?: OrganizationMembershipRole;
  // Legacy aliases
  leagueName?: string;
  leagueSlug?: string;
}

export interface AcceptInvitationResult {
  message: string;
  organizationId: string;
  organizationName: string;
  // Legacy aliases
  leagueId?: string;
  leagueName?: string;
}

// -----------------------------------------------------------------------------
// Game Types
// -----------------------------------------------------------------------------

export interface Player {
  id: string;
  divisionId?: string; // ID of the division this player belongs to (from API)
  bib: string; // Unique ID from evaluation day
  firstName: string;
  lastName: string;
  name: string; // Full name (firstName + lastName)

  // Raw Component Scores (from evaluations)
  fieldScore: number;
  throwScore: number;
  hitPower: number;
  hitForm: number;
  hitContact: number;
  pitchingStrength: number;
  pitchingForm: number;
  catchScore: number;
  runningScore: number;

  // Calculated Subtotals (weighted aggregates)
  fieldingSubtotal: number;
  hittingSubtotal: number;
  pitchingSubtotal: number;
  subjectiveTotal: number; // Sum of weighted subjective scores
  objectiveTotal: number; // Sum of objective scores
  officialAdjust: number;

  totalScore: number;
  rank: number;
  projectedRound: number;

  // Player Info
  littleLeagueAge: number;
  birthday: string;
  isAllStar: boolean;
  isDNE: boolean; // Did Not Evaluate

  // Draft Rules
  isCoachKid: boolean;
  coachTeamId?: string;
  sibling?: string; // Display name of sibling
  siblingId?: string; // ID of linked sibling player

  // Locked assignments (for same-round conflicts and sibling requirements)
  lockedToRound?: number; // Override projectedRound for mandatory pick timing
  lockedToTeamId?: string; // Team that must draft this player (set when sibling is drafted)

  // Draft Status
  isDrafted: boolean;
  draftedByTeamId?: string;
  draftedInRound?: number;
  draftedAtPick?: number;

  // Team Builder fields (for league-generated mode)
  coachRequest?: string; // Raw coach name from registration
  teammateRequests?: string[]; // Parsed teammate names from registration
  school?: string;
  grade?: number;
}

export interface Team {
  id: string;
  divisionId?: string; // ID of the division this team belongs to (from API)

  // Team Identity - the actual team name (e.g., "Guardians", "Yankees")
  // Empty until assigned, typically after draft completion
  teamName: string;

  // Coaching Staff
  headCoach: string;      // Manager's last name (e.g., "Bonacorsi")
  assistantCoach: string; // Assistant's last name

  // Draft & Roster
  draftPosition: number;  // 1-8, determines draft order
  roster: Player[];
  totalScore: number;
  coachKids: string[];    // Player IDs of coach's kids assigned to this team
  ageBreakdown: Record<string, number>; // { "10": 3, "11": 4, "12": 2 } - count per age
}

export interface DraftPick {
  round: number;
  pick: number;
  teamId: string;
  playerId?: string;
  timestamp?: number;
  wasSkipped?: boolean;
}

export type DraftFormat = 'straight' | 'snake' | 'recalculated';

export interface DraftConfig {
  teams: Team[];
  draftFormat: DraftFormat;
  draftOrder: string[]; // team IDs in order
}

export interface DraftState {
  id?: string; // Backend draft state ID (for API mode)
  divisionId?: string; // ID of the division this draft belongs to (from API)
  players: Player[];
  teams: Team[];
  draftFormat: DraftFormat;
  draftOrder: string[]; // team IDs (initial order)
  currentRoundOrder: string[]; // team IDs for current round (cached)
  picks: DraftPick[];
  currentRound: number;
  currentPickInRound: number;
  currentTeamId: string | null;
  isDraftComplete: boolean;
  mandatoryPick?: {
    playerId: string;
    reason: 'coach-kid' | 'sibling';
    siblingName?: string;
  };
  trades: Trade[];
}

export interface Trade {
  id: string;
  timestamp: number;
  team1Id: string;
  team2Id: string;
  player1Id: string; // moving FROM team1 TO team2
  player2Id: string; // moving FROM team2 TO team1
  reason: string;
}

export interface CSVRow {
  'First Name': string;
  'Last Name': string;
  'FIELDING SUBTOTAL': string;
  'HITTING SUBTOTAL': string;
  'PITCHING SUBTOTAL': string;
  'CATCH SCORE': string;
  'RUNNING Score': string;
  'Official Adjust': string;
  'Little League Age': string;
  'Birthday': string;
  'All-Star': string;
  'DNE': string;
  'Coach Kid'?: string;
  'Sibling'?: string;
}

export type ViewMode = 'list' | 'grid';

export type AppPhase = 'upload' | 'mapping' | 'review' | 'config' | 'draft' | 'complete';

export type AppField =
  | 'bib'
  | 'firstName'
  | 'lastName'
  | 'fieldScore'
  | 'throwScore'
  | 'hitPower'
  | 'hitForm'
  | 'hitContact'
  | 'pitchingStrength'
  | 'pitchingForm'
  | 'fieldingSubtotal'
  | 'hittingSubtotal'
  | 'pitchingSubtotal'
  | 'catchScore'
  | 'flyBallForm'
  | 'runningScore'
  | 'runningForm'
  | 'officialAdjust'
  | 'littleLeagueAge'
  | 'birthday'
  | 'isAllStar'
  | 'isDNE'
  | 'isCoachKid'
  | 'coachTeam' // Team name for coach kid assignment (headCoach name)
  | 'sibling'
  | 'school' // School name for clustering
  | 'managerTeam'
  | 'assistantTeam'
  | 'teamColumn' // "Manager, Assistant" format for auto team creation
  | 'totalScore'; // Overall/total score (alternative to component scores)

export interface ColumnMapping {
  [csvColumn: string]: AppField | null;
}

export interface ParsedCSVData {
  headers: string[];
  rows: Record<string, string>[];
}

export interface ScoringWeights {
  fielding: {
    field: number;  // % weight for field score
    throw: number;  // % weight for throw score
  };
  hitting: {
    power: number;   // % weight for hit power
    form: number;    // % weight for hit form
    contact: number; // % weight for hit contact
  };
  pitching: {
    strength: number; // % weight for pitching strength
    form: number;     // % weight for pitching form
  };
  catching: number;   // % weight for catch score
  running: number;    // % weight for running score
}

// Scoring mode determines how CSV scores are interpreted
export type ScoringMode = 'raw' | 'pre-weighted';

// Default weights based on evaluation criteria
export const DEFAULT_SCORING_WEIGHTS: ScoringWeights = {
  fielding: {
    field: 15.0,
    throw: 13.0,
  },
  hitting: {
    power: 9.0,
    form: 9.0,
    contact: 9.0,
  },
  pitching: {
    strength: 20.0,
    form: 15.0,
  },
  catching: 5.0,
  running: 5.0,
};

// Division types for multi-division support
export type DivisionPreset = 'majors' | 'aaa' | 'aa' | 'custom';

// Division mode: how teams are formed
export type DivisionMode = 'live-draft' | 'league-generated';

export interface DivisionAgeRange {
  min: number;
  max: number;
}

export interface Division {
  id: string;
  name: string;
  preset: DivisionPreset;
  mode: DivisionMode; // How teams are formed (immutable after creation)
  ageRange: DivisionAgeRange;
  enforceAgeLimit: boolean;
  maxPerAge: number; // Max players per age group (0 = no limit)
  teamCount: number; // 5-10 teams
  rosterSize: number; // Calculated: players ÷ teams
  teams: Team[];
  players: Player[];
  draftState: DraftState | null;
  scoringWeights: ScoringWeights;
  scoringMode: ScoringMode; // Whether CSV scores are raw or pre-weighted
  phase: AppPhase;
  createdAt: string; // ISO date string
  updatedAt?: string; // ISO date string (from API)
  completedAt?: string; // ISO date string

  // Organization or personal workspace ownership
  organizationId?: string; // If part of an organization
  ownerId?: string; // If personal workspace
  isPersonal: boolean; // True if personal workspace (no organization)
}

export interface DivisionSummary {
  id: string;
  name: string;
  preset: DivisionPreset;
  mode: DivisionMode;
  teamCount: number;
  playerCount: number;
  phase: AppPhase;
  createdAt: string;
  completedAt?: string;

  // Organization or personal workspace ownership
  organizationId?: string;
  ownerId?: string;
  isPersonal: boolean;
}

// Preset configurations for common divisions
export const DIVISION_PRESETS: Record<Exclude<DivisionPreset, 'custom'>, {
  name: string;
  ageRange: DivisionAgeRange;
  enforceAgeLimit: boolean;
  maxPerAge: number;
}> = {
  majors: {
    name: 'Majors',
    ageRange: { min: 10, max: 12 },
    enforceAgeLimit: true,
    maxPerAge: 8,
  },
  aaa: {
    name: 'AAA',
    ageRange: { min: 8, max: 10 },
    enforceAgeLimit: true,
    maxPerAge: 8,
  },
  aa: {
    name: 'AA',
    ageRange: { min: 7, max: 10 },
    enforceAgeLimit: false,
    maxPerAge: 0, // No limit
  },
};

// -----------------------------------------------------------------------------
// Team Builder Request Resolution Types
// -----------------------------------------------------------------------------

/**
 * Resolved request for the Team Builder request confirmation step.
 * Tracks both auto-resolved and user-confirmed requests.
 */
export interface ResolvedRequest {
  id: string;
  playerId: string;                    // Player making the request
  requestType: 'coach' | 'teammate';
  rawRequestString: string;            // Original text from Excel
  resolvedTargetId: string | null;     // Team ID (coach) or Player ID (teammate)
  resolvedTargetName: string | null;
  status: 'auto-confirmed' | 'needs-review' | 'user-confirmed' | 'unresolvable';
  confidenceScore: number;             // 0-1 from fuzzy matching
  isTwoWay: boolean;                   // For teammate requests: both players requested each other
  suggestedMatches?: Array<{ id: string; name: string; score: number }>;
}

/**
 * Configuration for the requests-first team builder algorithm.
 */
export interface RequestsFirstConfig {
  // Request weights for scoring
  twoWayTeammateWeight: number;      // Default: 100
  oneWayTeammateWeight: number;      // Default: 50
  coachRequestWeight: number;        // Default: 30
  schoolClusterWeight: number;       // Default: 10

  // Constraints
  maxRosterSize: number;             // Default: 13
  minRosterSize: number;             // Default: 10
  forceEvenTeams: boolean;           // Default: false - if true, teams differ by at most 1 player

  // Balance phase
  balanceMode: 'auto-trade' | 'suggest-trade' | 'manual-only';
  maxAutoTrades: number;             // Default: 10
  targetBalanceSpread: number;       // Default: 0.10 (10%)

  // Confirmation thresholds
  autoConfirmThreshold: number;      // Default: 0.90
  needsReviewThreshold: number;      // Default: 0.50
}

/**
 * Default configuration for requests-first algorithm.
 */
export const DEFAULT_REQUESTS_FIRST_CONFIG: RequestsFirstConfig = {
  twoWayTeammateWeight: 100,
  oneWayTeammateWeight: 50,
  coachRequestWeight: 30,
  schoolClusterWeight: 10,
  maxRosterSize: 13,
  minRosterSize: 10,
  forceEvenTeams: false,
  balanceMode: 'suggest-trade',
  maxAutoTrades: 10,
  targetBalanceSpread: 0.10,
  autoConfirmThreshold: 0.90,
  needsReviewThreshold: 0.50,
};

/**
 * A cluster of players connected by two-way requests.
 * These players should ideally be placed on the same team.
 */
export interface RequestCluster {
  id: string;
  playerIds: string[];
  preferredTeamIds: string[];  // From coach requests within the cluster
  totalWeight: number;
  warnings: string[];          // e.g., "Cluster too large for one team"
}

/**
 * Candidate trade for balancing teams after requests-first assignment.
 */
export interface TradeCandidate {
  id: string;
  fromTeamId: string;
  toTeamId: string;
  player1Id: string;           // Moving from fromTeam to toTeam
  player2Id: string;           // Moving from toTeam to fromTeam
  balanceImprovement: number;  // How much this trade improves balance (higher is better)
  player1Name: string;
  player2Name: string;
  fromTeamName: string;
  toTeamName: string;
}

// -----------------------------------------------------------------------------
// Evaluation Template Types
// -----------------------------------------------------------------------------

export type ScoreFieldType = 'scale' | 'time' | 'count';
export type CoachCategoryType = 'physical' | 'soft';

export interface ScoreFieldDefinition {
  id: string;
  name: string;
  type: ScoreFieldType;
  min: number;
  max: number;
  description?: string;
  unit?: string;
  lowerIsBetter?: boolean;
  anchors?: Record<string, string>;
}

export interface StationDefinition {
  id: string;
  name: string;
  order: number;
  fields: ScoreFieldDefinition[];
}

export interface CoachCategoryDefinition {
  id: string;
  name: string;
  type: CoachCategoryType;
  min: number;
  max: number;
  anchors?: Record<string, string>;
}

export interface BlendWeights {
  coachRating: number;
  tryoutScore: number;
}

export interface EvaluationTemplate {
  id: string;
  organizationId: string;
  name: string;
  description: string;
  version: number;
  parentTemplateId: string | null;
  stations: StationDefinition[];
  coachCategories: CoachCategoryDefinition[];
  blendWeights: BlendWeights;
  isActive: boolean;
  isLocked: boolean;
  createdById: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface Season {
  id: string;
  organizationId: string;
  name: string;
  year: number;
  templateId: string;
  isActive: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface CreateTemplateData {
  name: string;
  description?: string;
  stations: StationDefinition[];
  coachCategories: CoachCategoryDefinition[];
  blendWeights: BlendWeights;
}

export interface CreateSeasonData {
  name: string;
  year: number;
  templateId: string;
}

// Helper to create initial division state
export function createInitialDivision(
  id: string,
  name: string,
  preset: DivisionPreset,
  teamCount: number,
  ageRange: DivisionAgeRange,
  enforceAgeLimit: boolean,
  maxPerAge: number,
  mode: DivisionMode = 'live-draft'
): Division {
  const teams: Team[] = Array.from({ length: teamCount }, (_, i) => ({
    id: `${id}-team-${i + 1}`,
    teamName: '', // Empty until actual team name (e.g., "Guardians") is assigned
    headCoach: '',
    assistantCoach: '',
    roster: [],
    totalScore: 0,
    draftPosition: i + 1,
    coachKids: [],
    ageBreakdown: {},
  }));

  return {
    id,
    name,
    preset,
    mode,
    ageRange,
    enforceAgeLimit,
    maxPerAge,
    teamCount,
    rosterSize: 0,
    teams,
    players: [],
    draftState: null,
    scoringWeights: { ...DEFAULT_SCORING_WEIGHTS },
    scoringMode: 'pre-weighted', // Default to pre-weighted since most CSVs have this format
    phase: 'upload',
    createdAt: new Date().toISOString(),
    isPersonal: true, // Default to personal workspace
  };
}
