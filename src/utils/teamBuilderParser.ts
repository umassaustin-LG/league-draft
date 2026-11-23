/**
 * Team Builder Excel Parser
 *
 * Handles parsing of Registration Data tab which contains:
 * - First Name, Last Name (no BIB)
 * - Coach Request
 * - Teammate Requests (comma or space delimited)
 * - School
 * - Grade
 * - Address (used only for sibling detection, not persisted)
 *
 * This data must be linked to evaluation data via name matching.
 */

import * as XLSX from 'xlsx';

// -----------------------------------------------------------------------------
// Types
// -----------------------------------------------------------------------------

export interface RegistrationRow {
  firstName: string;
  lastName: string;
  fullName: string; // Normalized: "FirstName LastName"
  coachRequest: string;
  teammateRequests: string[]; // Parsed from comma/space delimited string
  school: string;
  grade: number | null;
  address: string; // Used only for sibling detection, not stored
  littleLeagueAge: number | null; // LL age (age between 9/1 prev year and 8/31 league year)
  rawTeammateRequestsString: string; // Original string for debugging
}

export interface RegistrationData {
  rows: RegistrationRow[];
  headers: string[];
  warnings: RegistrationWarning[];
}

export interface RegistrationWarning {
  type: 'missing_name' | 'invalid_grade' | 'empty_row' | 'parse_error';
  message: string;
  rowIndex?: number;
}

export interface PlayerMatch {
  registrationIndex: number;
  evalBib: string | null; // null if no match found
  evalFirstName: string | null;
  evalLastName: string | null;
  matchType: 'exact' | 'fuzzy' | 'none';
  matchScore: number; // 0-1, higher is better
  suggestedMatches?: Array<{
    bib: string;
    firstName: string;
    lastName: string;
    score: number;
  }>;
}

export interface TeammateRequest {
  rawString: string; // Original request string
  resolvedPlayerId: string | null; // Matched player ID (or null if unresolved)
  resolvedPlayerName: string | null; // Matched player name for display
  isTwoWay: boolean; // True if both players requested each other
  matchType: 'exact' | 'fuzzy' | 'none';
  suggestedMatches?: Array<{
    playerId: string;
    name: string;
    score: number;
  }>;
}

// -----------------------------------------------------------------------------
// Registration Data Tab Parser
// -----------------------------------------------------------------------------

/**
 * Parse the Registration Data tab from an Excel sheet.
 * This tab has NO BIB column - players are identified by name.
 */
export function parseRegistrationDataTab(
  sheet: XLSX.WorkSheet,
  sheetName: string
): RegistrationData | null {
  const warnings: RegistrationWarning[] = [];

  // Find header row by looking for "First Name" column
  const headerRow = detectRegistrationHeaderRow(sheet);
  if (headerRow === -1) {
    console.warn(`No First Name column found in sheet: ${sheetName}`);
    return null;
  }

  // Extract headers
  const headers = extractHeadersFromRow(sheet, headerRow);

  // Find column indices
  const columnMap = mapRegistrationColumns(headers);
  if (!columnMap.firstName || !columnMap.lastName) {
    console.warn(`Missing required name columns in sheet: ${sheetName}`);
    return null;
  }

  // Extract data rows
  const rows = extractRegistrationRows(sheet, headerRow, headers, columnMap, warnings);

  return {
    rows,
    headers,
    warnings,
  };
}

/**
 * Detect header row by finding "First Name" column (case-insensitive)
 */
function detectRegistrationHeaderRow(sheet: XLSX.WorkSheet): number {
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:Z1');

  // Search first 15 rows for First Name column
  for (let row = 0; row <= Math.min(14, range.e.r); row++) {
    for (let col = 0; col <= range.e.c; col++) {
      const cellAddress = XLSX.utils.encode_cell({ r: row, c: col });
      const cell = sheet[cellAddress];
      if (cell && cell.v) {
        const value = String(cell.v).toLowerCase().trim();
        if (value === 'first name' || value === 'firstname' || value === 'first') {
          return row;
        }
      }
    }
  }

  return -1;
}

/**
 * Extract all headers from a row
 */
function extractHeadersFromRow(sheet: XLSX.WorkSheet, headerRow: number): string[] {
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:Z1');
  const headers: string[] = [];

  for (let col = 0; col <= range.e.c; col++) {
    const cellAddress = XLSX.utils.encode_cell({ r: headerRow, c: col });
    const cell = sheet[cellAddress];
    headers.push(cell && cell.v ? String(cell.v).trim() : '');
  }

  return headers;
}

/**
 * Map column headers to their indices
 */
function mapRegistrationColumns(headers: string[]): {
  firstName: number | null;
  lastName: number | null;
  coachRequest: number | null;
  teammateRequests: number | null;
  school: number | null;
  grade: number | null;
  address: number | null;
  littleLeagueAge: number | null;
  birthdate: number | null;
} {
  const map = {
    firstName: null as number | null,
    lastName: null as number | null,
    coachRequest: null as number | null,
    teammateRequests: null as number | null,
    school: null as number | null,
    grade: null as number | null,
    address: null as number | null,
    littleLeagueAge: null as number | null,
    birthdate: null as number | null,
  };

  headers.forEach((header, index) => {
    const h = header.toLowerCase().trim();

    // First Name
    if (h === 'first name' || h === 'firstname' || h === 'first') {
      map.firstName = index;
    }
    // Last Name
    else if (h === 'last name' || h === 'lastname' || h === 'last') {
      map.lastName = index;
    }
    // Coach Request
    else if (h.includes('coach') && (h.includes('request') || h.includes('preference'))) {
      map.coachRequest = index;
    }
    // Teammate Requests
    else if (
      (h.includes('teammate') || h.includes('friend')) &&
      (h.includes('request') || h.includes('preference'))
    ) {
      map.teammateRequests = index;
    }
    // School
    else if (h === 'school' || h.includes('school name')) {
      map.school = index;
    }
    // Grade
    else if (h === 'grade' || h === 'grade level') {
      map.grade = index;
    }
    // Address (for sibling detection only)
    else if (h === 'address' || h.includes('street') || h.includes('home address')) {
      map.address = index;
    }
    // Little League Age
    else if (h.includes('little league') && h.includes('age')) {
      map.littleLeagueAge = index;
    }
    else if (h === 'll age' || h === 'llage') {
      map.littleLeagueAge = index;
    }
    else if ((h === 'age' || h.endsWith(' age')) && map.littleLeagueAge === null) {
      // Fallback to generic "age" column only if no LL age found
      map.littleLeagueAge = index;
    }
    // Birthdate column - for calculating LL age if not provided directly
    else if (
      (h.includes('birth') && (h.includes('date') || h.includes('day'))) ||
      h === 'birthdate' || h === 'birthday' || h === 'dob' || h === 'date of birth'
    ) {
      if (!map.birthdate) {
        map.birthdate = index;
      }
    }
  });

  return map;
}

/**
 * Extract registration data rows
 */
function extractRegistrationRows(
  sheet: XLSX.WorkSheet,
  headerRow: number,
  _headers: string[], // Available for future use
  columnMap: ReturnType<typeof mapRegistrationColumns>,
  warnings: RegistrationWarning[]
): RegistrationRow[] {
  const range = XLSX.utils.decode_range(sheet['!ref'] || 'A1:Z1');
  const rows: RegistrationRow[] = [];

  // Start from headerRow + 1
  for (let row = headerRow + 1; row <= range.e.r; row++) {
    const getCellValue = (colIndex: number | null): string => {
      if (colIndex === null) return '';
      const cellAddress = XLSX.utils.encode_cell({ r: row, c: colIndex });
      const cell = sheet[cellAddress];
      return cell && cell.v !== undefined ? String(cell.v).trim() : '';
    };

    const firstName = getCellValue(columnMap.firstName);
    const lastName = getCellValue(columnMap.lastName);

    // Skip empty rows
    if (!firstName && !lastName) {
      continue;
    }

    // Warn if missing name component
    if (!firstName || !lastName) {
      warnings.push({
        type: 'missing_name',
        message: `Row ${row + 1}: Missing ${!firstName ? 'first' : 'last'} name`,
        rowIndex: row,
      });
      continue;
    }

    const coachRequest = getCellValue(columnMap.coachRequest);
    const rawTeammateRequests = getCellValue(columnMap.teammateRequests);
    const school = getCellValue(columnMap.school);
    const gradeStr = getCellValue(columnMap.grade);
    const address = getCellValue(columnMap.address);
    const llAgeStr = getCellValue(columnMap.littleLeagueAge);

    // Get raw birthdate cell value for parsing
    const getBirthDateCellValue = (): unknown => {
      if (columnMap.birthdate === null) return null;
      const cellAddress = XLSX.utils.encode_cell({ r: row, c: columnMap.birthdate });
      const cell = sheet[cellAddress];
      return cell?.v;
    };

    // Parse Little League Age - prefer direct age column, calculate from birthdate if needed
    let littleLeagueAge: number | null = null;
    if (llAgeStr) {
      const parsed = parseInt(llAgeStr);
      if (!isNaN(parsed) && parsed > 0 && parsed < 20) {
        littleLeagueAge = parsed;
      }
    }

    // If no LL age but we have a birthdate, calculate it
    if (!littleLeagueAge && columnMap.birthdate !== null) {
      const birthdateValue = getBirthDateCellValue();
      const birthdate = parseExcelDateValue(birthdateValue);
      if (birthdate) {
        littleLeagueAge = calculateLittleLeagueAge(birthdate);
      }
    }

    // Parse grade
    let grade: number | null = null;
    if (gradeStr) {
      const parsed = parseInt(gradeStr);
      if (!isNaN(parsed) && parsed >= 0 && parsed <= 12) {
        grade = parsed;
      } else {
        warnings.push({
          type: 'invalid_grade',
          message: `Row ${row + 1}: Invalid grade "${gradeStr}"`,
          rowIndex: row,
        });
      }
    }

    // Parse teammate requests
    const teammateRequests = parseTeammateRequestsString(rawTeammateRequests);

    // Filter out placeholder school values
    const normalizedSchool = school.trim();
    const validSchool = isPlaceholderSchool(normalizedSchool) ? '' : normalizedSchool;

    rows.push({
      firstName: normalizeName(firstName),
      lastName: normalizeName(lastName),
      fullName: `${normalizeName(firstName)} ${normalizeName(lastName)}`,
      coachRequest: coachRequest.trim(),
      teammateRequests,
      school: validSchool,
      grade,
      address: address.trim(),
      littleLeagueAge,
      rawTeammateRequestsString: rawTeammateRequests,
    });
  }

  return rows;
}

// -----------------------------------------------------------------------------
// Name Normalization & Parsing
// -----------------------------------------------------------------------------

/**
 * Check if a school name is a placeholder value that should be ignored.
 * Examples: "Other/None of the Above", "N/A", "Not Listed", etc.
 */
export function isPlaceholderSchool(schoolName: string): boolean {
  if (!schoolName || !schoolName.trim()) return true;
  const lower = schoolName.toLowerCase().trim();
  return /^(other|none|n\/a|na|not applicable|unknown|unspecified|prefer not)/.test(lower) ||
         lower.includes('none of the above') ||
         lower.includes('not listed') ||
         lower.includes('prefer not to') ||
         lower === '-' ||
         lower === '--';
}

/**
 * Normalize a name: capitalize first letter, lowercase rest
 */
export function normalizeName(name: string): string {
  if (!name) return '';
  const trimmed = name.trim();
  if (trimmed.length === 0) return '';

  // Handle names with multiple parts (e.g., "Mary Jane")
  return trimmed
    .split(/\s+/)
    .map(part => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(' ');
}

/**
 * Parse teammate requests from a string.
 * Handles various delimiter formats and name patterns.
 *
 * Examples:
 * - "Mike Smith, Jake Johnson" -> ["Mike Smith", "Jake Johnson"]
 * - "Jett Janda + Caden Vandegrift" -> ["Jett Janda", "Caden Vandegrift"]
 * - "Sam Hagedorn and Aidan Brown" -> ["Sam Hagedorn", "Aidan Brown"]
 * - "Smith Johnson" -> ["Smith", "Johnson"] (last names only)
 * - "Mike Smith Jake Johnson" -> attempts to detect full names vs last names
 * - "Joey (Joseph) Park" -> "Joseph Park" (extracts name from parentheses)
 * - "JackSmithMikeJones" -> attempts to split camelCase/concatenated names
 */
export function parseTeammateRequestsString(raw: string): string[] {
  if (!raw || raw.trim() === '') return [];

  let trimmed = raw.trim();

  // Check for concatenated names (no spaces, multiple capitals like "JackFulcherColeSkaranHudsonGon")
  if (!trimmed.includes(' ') && /[a-z][A-Z]/.test(trimmed)) {
    // Split on capital letters
    const splitNames = trimmed.split(/(?=[A-Z])/).filter(s => s.length > 0);
    // Try to pair them as first/last names
    if (splitNames.length >= 2 && splitNames.length % 2 === 0) {
      const names: string[] = [];
      for (let i = 0; i < splitNames.length; i += 2) {
        names.push(normalizeRequestName(`${splitNames[i]} ${splitNames[i + 1]}`));
      }
      return names;
    }
    // If odd number, might be last names only
    return splitNames.map(normalizeRequestName);
  }

  // Normalize delimiters: replace +, &, ;, and " and " with comma
  trimmed = trimmed.replace(/\s*[+&;]\s*/g, ', ');
  trimmed = trimmed.replace(/\s+and\s+/gi, ', ');

  // If contains comma, split by comma
  if (trimmed.includes(',')) {
    return trimmed
      .split(',')
      .map(s => s.trim())
      .filter(s => s.length > 0)
      .map(normalizeRequestName);
  }

  // Otherwise, try to intelligently split
  // If we have pairs of capitalized words, they might be "First Last" names
  // Otherwise, treat each word as a separate name (likely last names)
  const words = trimmed.split(/\s+/).filter(w => w.length > 0);

  if (words.length === 0) return [];
  if (words.length === 1) return [normalizeRequestName(words[0])];

  // Heuristic: if all words start with capital and we have even count,
  // try to pair them as "First Last" names
  const allCapitalized = words.every(w => /^[A-Z]/i.test(w));
  if (allCapitalized && words.length % 2 === 0 && words.length <= 6) {
    const names: string[] = [];
    for (let i = 0; i < words.length; i += 2) {
      names.push(normalizeRequestName(`${words[i]} ${words[i + 1]}`));
    }
    return names;
  }

  // Default: treat each word as a separate name (likely last names)
  return words.map(normalizeRequestName);
}

/**
 * Normalize a request name, handling special patterns like:
 * - "Joey (Joseph) Park" -> "Joseph Park"
 * - "E. Tiller" -> "E Tiller" (keep initial for matching)
 * - "Will N" -> "Will N" (keep as-is for partial matching)
 */
function normalizeRequestName(name: string): string {
  if (!name) return '';
  let trimmed = name.trim();

  // Handle "Nickname (RealName) LastName" pattern
  // e.g., "Joey (Joseph) Park" -> "Joseph Park"
  const parenMatch = trimmed.match(/^[\w]+\s*\((\w+)\)\s*([\w]+)$/);
  if (parenMatch) {
    trimmed = `${parenMatch[1]} ${parenMatch[2]}`;
  }

  // Remove periods from initials but keep the letter
  // e.g., "E. Tiller" -> "E Tiller"
  trimmed = trimmed.replace(/\.\s*/g, ' ').replace(/\s+/g, ' ').trim();

  return normalizeName(trimmed);
}

// -----------------------------------------------------------------------------
// Name Matching (Fuzzy)
// -----------------------------------------------------------------------------

/**
 * Calculate Levenshtein distance between two strings
 */
export function levenshteinDistance(a: string, b: string): number {
  const matrix: number[][] = [];

  const aLen = a.length;
  const bLen = b.length;

  if (aLen === 0) return bLen;
  if (bLen === 0) return aLen;

  // Initialize matrix
  for (let i = 0; i <= bLen; i++) {
    matrix[i] = [i];
  }
  for (let j = 0; j <= aLen; j++) {
    matrix[0][j] = j;
  }

  // Fill matrix
  for (let i = 1; i <= bLen; i++) {
    for (let j = 1; j <= aLen; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        matrix[i][j] = matrix[i - 1][j - 1];
      } else {
        matrix[i][j] = Math.min(
          matrix[i - 1][j - 1] + 1, // substitution
          matrix[i][j - 1] + 1,     // insertion
          matrix[i - 1][j] + 1      // deletion
        );
      }
    }
  }

  return matrix[bLen][aLen];
}

/**
 * Calculate similarity score between two names (0-1, higher is better)
 */
export function nameSimilarity(name1: string, name2: string): number {
  const n1 = name1.toLowerCase().trim();
  const n2 = name2.toLowerCase().trim();

  if (n1 === n2) return 1;
  if (n1.length === 0 || n2.length === 0) return 0;

  const distance = levenshteinDistance(n1, n2);
  const maxLength = Math.max(n1.length, n2.length);

  return 1 - distance / maxLength;
}

/**
 * Match a registration row to evaluation data by name.
 * Returns exact match, fuzzy matches, or no match.
 */
export function matchRegistrationToEval(
  registration: RegistrationRow,
  evalPlayers: Array<{ bib: string; firstName: string; lastName: string }>
): PlayerMatch {
  const regFullName = registration.fullName.toLowerCase();
  const regFirst = registration.firstName.toLowerCase();
  const regLast = registration.lastName.toLowerCase();

  // Try exact full name match first
  const exactMatch = evalPlayers.find(
    p =>
      p.firstName.toLowerCase() === regFirst &&
      p.lastName.toLowerCase() === regLast
  );

  if (exactMatch) {
    return {
      registrationIndex: -1, // Will be set by caller
      evalBib: exactMatch.bib,
      evalFirstName: exactMatch.firstName,
      evalLastName: exactMatch.lastName,
      matchType: 'exact',
      matchScore: 1,
    };
  }

  // Try fuzzy matching
  const candidates = evalPlayers.map(p => {
    const fullName = `${p.firstName} ${p.lastName}`.toLowerCase();
    const fullNameScore = nameSimilarity(regFullName, fullName);

    // Also try matching just last name (common case for partial matches)
    const lastNameScore = nameSimilarity(regLast, p.lastName.toLowerCase());

    // Use the better score
    const score = Math.max(fullNameScore, lastNameScore * 0.8); // Discount last-name-only matches

    return {
      bib: p.bib,
      firstName: p.firstName,
      lastName: p.lastName,
      score,
    };
  });

  // Sort by score descending
  candidates.sort((a, b) => b.score - a.score);

  // If best match is good enough (>= 0.8), consider it a fuzzy match
  const bestCandidate = candidates[0];
  if (bestCandidate && bestCandidate.score >= 0.8) {
    return {
      registrationIndex: -1,
      evalBib: bestCandidate.bib,
      evalFirstName: bestCandidate.firstName,
      evalLastName: bestCandidate.lastName,
      matchType: 'fuzzy',
      matchScore: bestCandidate.score,
      suggestedMatches: candidates.slice(0, 3).filter(c => c.score >= 0.5),
    };
  }

  // No good match - return suggestions
  return {
    registrationIndex: -1,
    evalBib: null,
    evalFirstName: null,
    evalLastName: null,
    matchType: 'none',
    matchScore: 0,
    suggestedMatches: candidates.slice(0, 5).filter(c => c.score >= 0.3),
  };
}

// -----------------------------------------------------------------------------
// Two-Way Request Detection
// -----------------------------------------------------------------------------

/**
 * Detect two-way teammate requests.
 * A two-way request exists when Player A requests Player B AND Player B requests Player A.
 */
export function detectTwoWayRequests(
  players: Array<{
    id: string;
    firstName: string;
    lastName: string;
    fullName: string;
    teammateRequests: string[];
  }>
): Map<string, Set<string>> {
  // Map of player ID -> Set of player IDs they have two-way requests with
  const twoWayMap = new Map<string, Set<string>>();

  for (const playerA of players) {
    for (const requestName of playerA.teammateRequests) {
      // Find player B who matches this request
      const playerB = findPlayerByName(players, requestName);
      if (!playerB) continue;

      // Check if player B also requested player A
      const bRequestsA = playerB.teammateRequests.some(req => {
        const matched = findPlayerByName(players, req);
        return matched?.id === playerA.id;
      });

      if (bRequestsA) {
        // Two-way request found
        if (!twoWayMap.has(playerA.id)) {
          twoWayMap.set(playerA.id, new Set());
        }
        if (!twoWayMap.has(playerB.id)) {
          twoWayMap.set(playerB.id, new Set());
        }
        twoWayMap.get(playerA.id)!.add(playerB.id);
        twoWayMap.get(playerB.id)!.add(playerA.id);
      }
    }
  }

  return twoWayMap;
}

/**
 * Find a player by name (exact or fuzzy match)
 */
function findPlayerByName<T extends { firstName: string; lastName: string; fullName: string }>(
  players: T[],
  name: string
): T | null {
  const normalizedName = name.toLowerCase().trim();

  // Try exact full name match
  const exactFull = players.find(p => p.fullName.toLowerCase() === normalizedName);
  if (exactFull) return exactFull;

  // Try exact last name match (if unique)
  const lastNameMatches = players.filter(p => p.lastName.toLowerCase() === normalizedName);
  if (lastNameMatches.length === 1) return lastNameMatches[0];

  // Try fuzzy match
  let bestMatch: T | null = null;
  let bestScore = 0;

  for (const player of players) {
    const fullNameScore = nameSimilarity(normalizedName, player.fullName.toLowerCase());
    const lastNameScore = nameSimilarity(normalizedName, player.lastName.toLowerCase()) * 0.8;
    const score = Math.max(fullNameScore, lastNameScore);

    if (score > bestScore && score >= 0.7) {
      bestScore = score;
      bestMatch = player;
    }
  }

  return bestMatch;
}

// -----------------------------------------------------------------------------
// Coach Request Resolution
// -----------------------------------------------------------------------------

export interface CoachInfo {
  teamId: string;
  teamName: string;
  coachName: string; // Head coach name
  assistantCoach?: string;
}

export interface CoachRequestMatch {
  rawRequest: string;
  matchedTeamId: string | null;
  matchedCoachName: string | null;
  matchType: 'exact' | 'fuzzy' | 'none';
  matchScore: number;
  /**
   * Request status:
   * - 'resolved': Successfully matched to a coach in the system
   * - 'possible': Coach likely exists (has good potential matches) but couldn't confidently match
   * - 'impossible': No coach in the system matches this request (coach doesn't exist)
   */
  requestStatus: 'resolved' | 'possible' | 'impossible';
  suggestedMatches?: Array<{
    teamId: string;
    coachName: string;
    score: number;
  }>;
}

/**
 * Resolve a coach request string to a team ID.
 * Matches against head coach and assistant coach names.
 */
export function resolveCoachRequest(
  request: string,
  coaches: CoachInfo[]
): CoachRequestMatch {
  if (!request || request.trim() === '') {
    return {
      rawRequest: request,
      matchedTeamId: null,
      matchedCoachName: null,
      matchType: 'none',
      matchScore: 0,
      requestStatus: 'impossible', // Empty request
    };
  }

  const normalizedRequest = request.toLowerCase().trim();

  // Try exact match on coach name (head or assistant)
  for (const coach of coaches) {
    const headCoachName = coach.coachName.toLowerCase().trim();
    const assistantName = (coach.assistantCoach || '').toLowerCase().trim();

    // Exact full name match
    if (headCoachName === normalizedRequest || assistantName === normalizedRequest) {
      return {
        rawRequest: request,
        matchedTeamId: coach.teamId,
        matchedCoachName: coach.coachName,
        matchType: 'exact',
        matchScore: 1,
        requestStatus: 'resolved',
      };
    }

    // Last name match (extract last word from coach name)
    const headLastName = headCoachName.split(/\s+/).pop() || '';
    const assistantLastName = assistantName.split(/\s+/).pop() || '';

    if (headLastName === normalizedRequest || assistantLastName === normalizedRequest) {
      return {
        rawRequest: request,
        matchedTeamId: coach.teamId,
        matchedCoachName: coach.coachName,
        matchType: 'exact',
        matchScore: 1,
        requestStatus: 'resolved',
      };
    }
  }

  // Try fuzzy matching
  const candidates = coaches.map(coach => {
    const headScore = nameSimilarity(normalizedRequest, coach.coachName.toLowerCase());
    const assistantScore = coach.assistantCoach
      ? nameSimilarity(normalizedRequest, coach.assistantCoach.toLowerCase())
      : 0;

    // Also try last name only matching
    const headLastName = coach.coachName.split(/\s+/).pop() || '';
    const lastNameScore = nameSimilarity(normalizedRequest, headLastName.toLowerCase()) * 0.9;

    const bestScore = Math.max(headScore, assistantScore, lastNameScore);

    return {
      teamId: coach.teamId,
      coachName: coach.coachName,
      score: bestScore,
    };
  });

  candidates.sort((a, b) => b.score - a.score);

  const bestCandidate = candidates[0];
  if (bestCandidate && bestCandidate.score >= 0.7) {
    return {
      rawRequest: request,
      matchedTeamId: bestCandidate.teamId,
      matchedCoachName: bestCandidate.coachName,
      matchType: 'fuzzy',
      matchScore: bestCandidate.score,
      requestStatus: 'resolved',
      suggestedMatches: candidates.slice(0, 3).filter(c => c.score >= 0.4),
    };
  }

  // No good match - determine if it's possible (has decent candidates) or impossible
  // A "possible" request means the coach might exist but we couldn't confidently match
  // An "impossible" request means the coach definitely doesn't exist in the system
  const hasPotentialMatches = candidates.some(c => c.score >= 0.4);

  return {
    rawRequest: request,
    matchedTeamId: null,
    matchedCoachName: null,
    matchType: 'none',
    matchScore: 0,
    requestStatus: hasPotentialMatches ? 'possible' : 'impossible',
    suggestedMatches: candidates.slice(0, 3).filter(c => c.score >= 0.3),
  };
}

/**
 * Resolve all coach requests for a list of players.
 * Returns a map of player ID to resolved coach team ID.
 */
export function resolveAllCoachRequests(
  players: Array<{ id: string; coachRequest: string }>,
  coaches: CoachInfo[]
): Map<string, CoachRequestMatch> {
  const results = new Map<string, CoachRequestMatch>();

  for (const player of players) {
    if (player.coachRequest && player.coachRequest.trim() !== '') {
      results.set(player.id, resolveCoachRequest(player.coachRequest, coaches));
    }
  }

  return results;
}

// -----------------------------------------------------------------------------
// Normalized Request Resolution
// -----------------------------------------------------------------------------

export interface NormalizedPlayer {
  id: string;
  bib: string;
  firstName: string;
  lastName: string;
  fullName: string;
  // Raw requests from registration
  rawCoachRequest: string;
  rawTeammateRequests: string[];
  rawSchool: string;
  // Resolved/normalized values
  resolvedCoachTeamId: string | null;
  resolvedCoachName: string | null;
  coachMatchType: 'exact' | 'fuzzy' | 'none';
  coachMatchScore: number;
  coachRequestStatus: 'resolved' | 'possible' | 'impossible' | 'none'; // 'none' = no request made
  resolvedTeammateIds: string[]; // Player IDs (using bib as ID)
  teammateResolutions: TeammateResolution[];
  normalizedSchool: string; // Normalized school name
  schoolId: string | null; // Unique school identifier
}

export interface TeammateResolution {
  rawRequest: string;
  resolvedPlayerId: string | null; // BIB of matched player
  resolvedPlayerName: string | null;
  matchType: 'exact' | 'fuzzy' | 'none';
  matchScore: number;
  isTwoWay: boolean;
  /**
   * Request status:
   * - 'resolved': Successfully matched to a player in the system
   * - 'possible': Player likely exists (has good potential matches) but couldn't confidently match
   * - 'impossible': No player in the system matches this request (person doesn't exist)
   */
  requestStatus: 'resolved' | 'possible' | 'impossible';
  suggestedMatches?: Array<{
    playerId: string;
    name: string;
    score: number;
  }>;
}

export interface SchoolNormalization {
  originalName: string;
  normalizedName: string;
  schoolId: string;
  playerCount: number;
}

export interface NormalizationResult {
  players: NormalizedPlayer[];
  schools: SchoolNormalization[];
  stats: {
    totalPlayers: number;
    playersWithCoachRequest: number;
    coachRequestsResolved: number;
    coachRequestsPossible: number; // Could match but didn't (coach exists)
    coachRequestsImpossible: number; // Coach doesn't exist in system
    playersWithTeammateRequest: number;
    teammateRequestsResolved: number;
    teammateRequestsPossible: number; // Could match but didn't (player exists)
    teammateRequestsImpossible: number; // Player doesn't exist in system
    totalTeammateRequests: number;
    twoWayRequestsFound: number;
    uniqueSchools: number;
  };
  warnings: string[];
}

/**
 * Normalize all request data for the team builder.
 * This is the main function that should be called after name matching
 * to resolve all coach requests, teammate requests, and school names.
 */
export function normalizeRequestData(
  players: Array<{
    id: string;
    bib: string;
    firstName: string;
    lastName: string;
    coachRequest?: string;
    teammateRequests?: string[];
    school?: string;
  }>,
  coaches: CoachInfo[]
): NormalizationResult {
  const warnings: string[] = [];

  // Step 1: Normalize schools first (we need school IDs for clustering)
  const schoolNormalizations = normalizeSchools(players);
  const schoolNameToId = new Map<string, string>();
  schoolNormalizations.forEach(s => {
    schoolNameToId.set(s.originalName.toLowerCase(), s.schoolId);
  });

  // Step 2: Resolve all requests for each player
  const normalizedPlayers: NormalizedPlayer[] = players.map(player => {
    const fullName = `${player.firstName} ${player.lastName}`;

    // Resolve coach request
    const coachMatch = player.coachRequest
      ? resolveCoachRequest(player.coachRequest, coaches)
      : null;

    // Resolve teammate requests
    const teammateResolutions = resolveTeammateRequests(
      player.teammateRequests || [],
      players,
      player.id
    );

    // Get normalized school
    const rawSchool = player.school || '';
    const schoolId = rawSchool ? schoolNameToId.get(rawSchool.toLowerCase()) || null : null;
    const normalizedSchool = schoolId
      ? schoolNormalizations.find(s => s.schoolId === schoolId)?.normalizedName || rawSchool
      : rawSchool;

    // Determine coach request status
    let coachRequestStatus: 'resolved' | 'possible' | 'impossible' | 'none' = 'none';
    if (player.coachRequest && player.coachRequest.trim()) {
      coachRequestStatus = coachMatch?.requestStatus || 'impossible';
    }

    return {
      id: player.id,
      bib: player.bib,
      firstName: player.firstName,
      lastName: player.lastName,
      fullName,
      rawCoachRequest: player.coachRequest || '',
      rawTeammateRequests: player.teammateRequests || [],
      rawSchool,
      resolvedCoachTeamId: coachMatch?.matchedTeamId || null,
      resolvedCoachName: coachMatch?.matchedCoachName || null,
      coachMatchType: coachMatch?.matchType || 'none',
      coachMatchScore: coachMatch?.matchScore || 0,
      coachRequestStatus,
      resolvedTeammateIds: teammateResolutions
        .filter(t => t.resolvedPlayerId)
        .map(t => t.resolvedPlayerId!),
      teammateResolutions,
      normalizedSchool,
      schoolId,
    };
  });

  // Step 3: Detect two-way requests now that all resolutions are done
  detectAndMarkTwoWayRequests(normalizedPlayers);

  // Calculate stats
  const playersWithCoachRequest = normalizedPlayers.filter(p => p.rawCoachRequest).length;
  const coachRequestsResolved = normalizedPlayers.filter(p => p.coachRequestStatus === 'resolved').length;
  const coachRequestsPossible = normalizedPlayers.filter(p => p.coachRequestStatus === 'possible').length;
  const coachRequestsImpossible = normalizedPlayers.filter(p => p.coachRequestStatus === 'impossible').length;

  const playersWithTeammateRequest = normalizedPlayers.filter(p => p.rawTeammateRequests.length > 0).length;
  const totalTeammateRequests = normalizedPlayers.reduce((sum, p) => sum + p.teammateResolutions.length, 0);
  const teammateRequestsResolved = normalizedPlayers.reduce(
    (sum, p) => sum + p.teammateResolutions.filter(t => t.requestStatus === 'resolved').length,
    0
  );
  const teammateRequestsPossible = normalizedPlayers.reduce(
    (sum, p) => sum + p.teammateResolutions.filter(t => t.requestStatus === 'possible').length,
    0
  );
  const teammateRequestsImpossible = normalizedPlayers.reduce(
    (sum, p) => sum + p.teammateResolutions.filter(t => t.requestStatus === 'impossible').length,
    0
  );
  const twoWayRequestsFound = normalizedPlayers.reduce(
    (sum, p) => sum + p.teammateResolutions.filter(t => t.isTwoWay).length,
    0
  ) / 2; // Divide by 2 since each two-way is counted twice

  // Generate warnings for unresolved requests with status info
  normalizedPlayers.forEach(p => {
    if (p.rawCoachRequest && p.coachRequestStatus !== 'resolved') {
      const status = p.coachRequestStatus === 'impossible' ? '(not in system)' : '(possible match)';
      warnings.push(`${p.fullName}: Coach request "${p.rawCoachRequest}" could not be matched ${status}`);
    }
    p.teammateResolutions.forEach(t => {
      if (t.requestStatus !== 'resolved' && t.rawRequest) {
        const status = t.requestStatus === 'impossible' ? '(not in system)' : '(possible match)';
        warnings.push(`${p.fullName}: Teammate request "${t.rawRequest}" could not be matched ${status}`);
      }
    });
  });

  return {
    players: normalizedPlayers,
    schools: schoolNormalizations,
    stats: {
      totalPlayers: players.length,
      playersWithCoachRequest,
      coachRequestsResolved,
      coachRequestsPossible,
      coachRequestsImpossible,
      playersWithTeammateRequest,
      teammateRequestsResolved,
      teammateRequestsPossible,
      teammateRequestsImpossible,
      totalTeammateRequests,
      twoWayRequestsFound,
      uniqueSchools: schoolNormalizations.length,
    },
    warnings,
  };
}

/**
 * Resolve teammate requests for a single player against the full player list.
 */
function resolveTeammateRequests(
  requests: string[],
  allPlayers: Array<{
    id: string;
    bib: string;
    firstName: string;
    lastName: string;
  }>,
  excludePlayerId: string
): TeammateResolution[] {
  // Filter out the requesting player
  const candidates = allPlayers.filter(p => p.id !== excludePlayerId);

  return requests.map(rawRequest => {
    if (!rawRequest || rawRequest.trim() === '') {
      return {
        rawRequest,
        resolvedPlayerId: null,
        resolvedPlayerName: null,
        matchType: 'none' as const,
        matchScore: 0,
        isTwoWay: false,
        requestStatus: 'impossible' as const, // Empty request
      };
    }

    const normalizedRequest = rawRequest.toLowerCase().trim();

    // Try exact matches first
    // 1. Exact full name match
    const exactFullName = candidates.find(
      p => `${p.firstName} ${p.lastName}`.toLowerCase() === normalizedRequest
    );
    if (exactFullName) {
      return {
        rawRequest,
        resolvedPlayerId: exactFullName.id,
        resolvedPlayerName: `${exactFullName.firstName} ${exactFullName.lastName}`,
        matchType: 'exact' as const,
        matchScore: 1,
        isTwoWay: false,
        requestStatus: 'resolved' as const,
      };
    }

    // 2. Exact last name match (if unique)
    const lastNameMatches = candidates.filter(
      p => p.lastName.toLowerCase() === normalizedRequest
    );
    if (lastNameMatches.length === 1) {
      return {
        rawRequest,
        resolvedPlayerId: lastNameMatches[0].id,
        resolvedPlayerName: `${lastNameMatches[0].firstName} ${lastNameMatches[0].lastName}`,
        matchType: 'exact' as const,
        matchScore: 1,
        isTwoWay: false,
        requestStatus: 'resolved' as const,
      };
    }

    // 3. Exact first name match (if unique) - sometimes kids just use first names
    const firstNameMatches = candidates.filter(
      p => p.firstName.toLowerCase() === normalizedRequest
    );
    if (firstNameMatches.length === 1) {
      return {
        rawRequest,
        resolvedPlayerId: firstNameMatches[0].id,
        resolvedPlayerName: `${firstNameMatches[0].firstName} ${firstNameMatches[0].lastName}`,
        matchType: 'exact' as const,
        matchScore: 0.95,
        isTwoWay: false,
        requestStatus: 'resolved' as const,
      };
    }

    // 4. Check for "First L" pattern (first name + last initial)
    // e.g., "Will N" should match "Will Nielsen"
    const firstLastInitialMatch = normalizedRequest.match(/^(\w+)\s+([a-z])$/i);
    if (firstLastInitialMatch) {
      const [, firstName, lastInitial] = firstLastInitialMatch;
      const initialMatches = candidates.filter(
        p => p.firstName.toLowerCase() === firstName.toLowerCase() &&
             p.lastName.toLowerCase().startsWith(lastInitial.toLowerCase())
      );
      if (initialMatches.length === 1) {
        return {
          rawRequest,
          resolvedPlayerId: initialMatches[0].id,
          resolvedPlayerName: `${initialMatches[0].firstName} ${initialMatches[0].lastName}`,
          matchType: 'exact' as const,
          matchScore: 0.95,
          isTwoWay: false,
          requestStatus: 'resolved' as const,
        };
      }
    }

    // 5. Check for "F. LastName" or "F LastName" pattern (first initial + last name)
    // e.g., "E Tiller" or "E. Tiller" should match "Ethan Tiller"
    const initialLastNameMatch = normalizedRequest.match(/^([a-z])\.?\s+(\w+)$/i);
    if (initialLastNameMatch) {
      const [, firstInitial, lastName] = initialLastNameMatch;
      const initialMatches = candidates.filter(
        p => p.firstName.toLowerCase().startsWith(firstInitial.toLowerCase()) &&
             p.lastName.toLowerCase() === lastName.toLowerCase()
      );
      if (initialMatches.length === 1) {
        return {
          rawRequest,
          resolvedPlayerId: initialMatches[0].id,
          resolvedPlayerName: `${initialMatches[0].firstName} ${initialMatches[0].lastName}`,
          matchType: 'exact' as const,
          matchScore: 0.95,
          isTwoWay: false,
          requestStatus: 'resolved' as const,
        };
      }
      // If multiple matches, still prefer this over fuzzy
      if (initialMatches.length > 1) {
        return {
          rawRequest,
          resolvedPlayerId: initialMatches[0].id,
          resolvedPlayerName: `${initialMatches[0].firstName} ${initialMatches[0].lastName}`,
          matchType: 'fuzzy' as const,
          matchScore: 0.85,
          isTwoWay: false,
          requestStatus: 'resolved' as const,
          suggestedMatches: initialMatches.map(p => ({
            playerId: p.id,
            name: `${p.firstName} ${p.lastName}`,
            score: 0.85,
          })),
        };
      }
    }

    // 6. Fuzzy matching with improved scoring
    const fuzzyMatches = candidates.map(p => {
      const fullName = `${p.firstName} ${p.lastName}`.toLowerCase();
      const fullNameScore = nameSimilarity(normalizedRequest, fullName);
      const lastNameScore = nameSimilarity(normalizedRequest, p.lastName.toLowerCase()) * 0.85;
      const firstNameScore = nameSimilarity(normalizedRequest, p.firstName.toLowerCase()) * 0.75;

      // Check for partial matches (e.g., "Mike" matching "Michael", "Will" matching "William")
      const isPartialFirst = p.firstName.toLowerCase().startsWith(normalizedRequest) ||
        normalizedRequest.startsWith(p.firstName.toLowerCase());
      const partialBonus = isPartialFirst ? 0.15 : 0;

      // Check for common nickname patterns
      const nicknameBonus = isNicknameMatch(normalizedRequest, p.firstName.toLowerCase()) ? 0.25 : 0;

      // Check if request matches "FirstName LastName" with typo in last name
      const requestParts = normalizedRequest.split(/\s+/);
      let typoBonus = 0;
      if (requestParts.length === 2) {
        const [reqFirst, reqLast] = requestParts;
        // Check first name match (exact or nickname)
        const firstMatches = p.firstName.toLowerCase() === reqFirst ||
                            isNicknameMatch(reqFirst, p.firstName.toLowerCase());
        if (firstMatches) {
          // First name matches, check last name similarity
          const lastSimilarity = nameSimilarity(reqLast, p.lastName.toLowerCase());
          if (lastSimilarity >= 0.6) {
            typoBonus = 0.2; // Boost for likely typo in last name
          }
        }

        // Also check if last name matches exactly and first is similar
        if (p.lastName.toLowerCase() === reqLast) {
          const firstSimilarity = nameSimilarity(reqFirst, p.firstName.toLowerCase());
          if (firstSimilarity >= 0.6 || isNicknameMatch(reqFirst, p.firstName.toLowerCase())) {
            typoBonus = Math.max(typoBonus, 0.2);
          }
        }
      }

      // Single word request matching first name with nickname check
      if (requestParts.length === 1 && nicknameBonus > 0) {
        // If it's a nickname match, give it a strong score
        return {
          playerId: p.id,
          name: `${p.firstName} ${p.lastName}`,
          score: 0.85,
        };
      }

      const bestScore = Math.max(fullNameScore, lastNameScore, firstNameScore) +
                        partialBonus + nicknameBonus + typoBonus;

      return {
        playerId: p.id,
        name: `${p.firstName} ${p.lastName}`,
        score: Math.min(bestScore, 1), // Cap at 1
      };
    }).sort((a, b) => b.score - a.score);

    const bestMatch = fuzzyMatches[0];

    // For single-word requests (likely first names), be more selective
    // Only match if there's one strong candidate or it's a nickname
    const requestParts = normalizedRequest.split(/\s+/);
    if (requestParts.length === 1) {
      // Check if multiple candidates have similar scores (ambiguous)
      const topMatches = fuzzyMatches.filter(m => m.score >= 0.7);
      if (topMatches.length === 1 && topMatches[0].score >= 0.7) {
        return {
          rawRequest,
          resolvedPlayerId: topMatches[0].playerId,
          resolvedPlayerName: topMatches[0].name,
          matchType: 'fuzzy' as const,
          matchScore: topMatches[0].score,
          isTwoWay: false,
          requestStatus: 'resolved' as const,
          suggestedMatches: fuzzyMatches.slice(0, 3).filter(m => m.score >= 0.4),
        };
      }
      // If ambiguous (multiple high-scoring matches), pick the best but note it
      if (bestMatch && bestMatch.score >= 0.75) {
        return {
          rawRequest,
          resolvedPlayerId: bestMatch.playerId,
          resolvedPlayerName: bestMatch.name,
          matchType: 'fuzzy' as const,
          matchScore: bestMatch.score,
          isTwoWay: false,
          requestStatus: 'resolved' as const,
          suggestedMatches: fuzzyMatches.slice(0, 3).filter(m => m.score >= 0.4),
        };
      }
    }

    // Threshold for fuzzy match acceptance
    if (bestMatch && bestMatch.score >= 0.55) {
      return {
        rawRequest,
        resolvedPlayerId: bestMatch.playerId,
        resolvedPlayerName: bestMatch.name,
        matchType: 'fuzzy' as const,
        matchScore: bestMatch.score,
        isTwoWay: false,
        requestStatus: 'resolved' as const,
        suggestedMatches: fuzzyMatches.slice(0, 3).filter(m => m.score >= 0.4),
      };
    }

    // No match found - determine if it's possible (has decent candidates) or impossible
    // A "possible" request means the player might exist but we couldn't confidently match
    // An "impossible" request means the player definitely doesn't exist in the system
    // Threshold: if best match is >= 0.35, consider it "possible" (might be a typo or nickname we don't know)
    const hasPotentialMatches = bestMatch && bestMatch.score >= 0.35;

    return {
      rawRequest,
      resolvedPlayerId: null,
      resolvedPlayerName: null,
      matchType: 'none' as const,
      matchScore: 0,
      isTwoWay: false,
      requestStatus: hasPotentialMatches ? 'possible' : 'impossible' as const,
      suggestedMatches: fuzzyMatches.slice(0, 5).filter(m => m.score >= 0.3),
    };
  });
}

/**
 * Check if a request might be a nickname for the actual name.
 */
function isNicknameMatch(request: string, actualName: string): boolean {
  const nicknames: Record<string, string[]> = {
    'william': ['will', 'willy', 'bill', 'billy', 'liam'],
    'joseph': ['joe', 'joey'],
    'michael': ['mike', 'mikey'],
    'robert': ['rob', 'robby', 'bob', 'bobby'],
    'richard': ['rick', 'ricky', 'dick', 'finn'], // Finn can be nickname for Richard
    'james': ['jim', 'jimmy', 'jamie'],
    'john': ['jack', 'johnny'],
    'thomas': ['tom', 'tommy'],
    'christopher': ['chris'],
    'matthew': ['matt'],
    'nicholas': ['nick', 'nicky'],
    'daniel': ['dan', 'danny'],
    'alexander': ['alex', 'xander'],
    'benjamin': ['ben', 'benny'],
    'samuel': ['sam', 'sammy'],
    'jonathan': ['jon', 'jonny'],
    'anthony': ['tony'],
    'edward': ['ed', 'eddie', 'ted'],
    'charles': ['charlie', 'chuck'],
    'joshua': ['josh'],
    'andrew': ['andy', 'drew'],
    'jacob': ['jake'],
    'ethan': ['e'],
    'nathan': ['nate'],
    'zachary': ['zach', 'zack'],
    'timothy': ['tim', 'timmy'],
    'steven': ['steve'],
    'stephen': ['steve'],
    'patrick': ['pat'],
    'cameron': ['cam'],
    'caden': ['cade'],
    'jett': ['jet'],
    'maxwell': ['max'],
    'maximilian': ['max'],
    'oliver': ['ollie'],
    'theodore': ['theo', 'ted', 'teddy'],
    'sebastian': ['seb'],
    'dominic': ['dom'],
    'elizabeth': ['liz', 'lizzy', 'beth'],
    'katherine': ['kate', 'katie', 'kathy'],
    'jennifer': ['jen', 'jenny'],
    'margaret': ['maggie', 'meg'],
    'elijah': ['eli'],
    'porter': ['port'],
    'finnegan': ['finn'],
    'finley': ['finn'],
    'aidan': ['aiden'],
    'aiden': ['aidan'],
    'cole': ['coleman'],
    'hudson': ['hud'],
    'wyatt': ['wy'],
    'burke': ['burk'],
    'sidhanth': ['sid'],
    'siddhant': ['sid'],
  };

  // Check if request is a nickname for actualName
  const actualLower = actualName.toLowerCase();
  const requestLower = request.toLowerCase();

  if (nicknames[actualLower]?.includes(requestLower)) {
    return true;
  }

  // Check reverse (if request is the full name and actual is nickname)
  for (const [fullName, nicks] of Object.entries(nicknames)) {
    if (nicks.includes(actualLower) && fullName === requestLower) {
      return true;
    }
  }

  // Check if actual name contains the request as a nickname entry
  for (const [fullName, nicks] of Object.entries(nicknames)) {
    if (actualLower === fullName && nicks.includes(requestLower)) {
      return true;
    }
    if (nicks.includes(requestLower) && nicks.includes(actualLower)) {
      return true; // Both are nicknames for the same name
    }
  }

  return false;
}

/**
 * After all teammate requests are resolved, detect which ones are two-way.
 */
function detectAndMarkTwoWayRequests(players: NormalizedPlayer[]): void {
  const playerById = new Map(players.map(p => [p.id, p]));

  for (const playerA of players) {
    for (const resolution of playerA.teammateResolutions) {
      if (!resolution.resolvedPlayerId) continue;

      const playerB = playerById.get(resolution.resolvedPlayerId);
      if (!playerB) continue;

      // Check if player B also resolved a request to player A
      const bRequestsA = playerB.teammateResolutions.some(
        t => t.resolvedPlayerId === playerA.id
      );

      if (bRequestsA) {
        resolution.isTwoWay = true;
      }
    }
  }
}

/**
 * Normalize school names by clustering similar names together.
 */
function normalizeSchools(
  players: Array<{ school?: string }>
): SchoolNormalization[] {
  // Collect all school names
  const schoolCounts = new Map<string, number>();
  players.forEach(p => {
    if (p.school && p.school.trim()) {
      const lower = p.school.trim().toLowerCase();
      schoolCounts.set(lower, (schoolCounts.get(lower) || 0) + 1);
    }
  });

  if (schoolCounts.size === 0) return [];

  // Cluster similar school names
  const schools = Array.from(schoolCounts.entries()).map(([name, count]) => ({
    original: name,
    count,
    clusterId: null as string | null,
  }));

  // Sort by count descending (most common names are canonical)
  schools.sort((a, b) => b.count - a.count);

  // Simple clustering: group names that are very similar
  let clusterCounter = 0;
  const clusters = new Map<string, { canonical: string; members: string[]; count: number }>();

  for (const school of schools) {
    if (school.clusterId) continue;

    // Start a new cluster with this school as canonical
    const clusterId = `school-${clusterCounter++}`;
    school.clusterId = clusterId;

    const clusterMembers = [school.original];
    let totalCount = school.count;

    // Find similar schools to add to this cluster
    for (const other of schools) {
      if (other.clusterId) continue;

      const similarity = schoolNameSimilarity(school.original, other.original);
      if (similarity >= 0.8) {
        other.clusterId = clusterId;
        clusterMembers.push(other.original);
        totalCount += other.count;
      }
    }

    clusters.set(clusterId, {
      canonical: school.original, // Most common variant is canonical
      members: clusterMembers,
      count: totalCount,
    });
  }

  // Build result
  const result: SchoolNormalization[] = [];
  const processed = new Set<string>();

  for (const school of schools) {
    if (processed.has(school.original)) continue;

    const cluster = clusters.get(school.clusterId!);
    if (!cluster) continue;

    // Add all members of this cluster
    for (const member of cluster.members) {
      if (processed.has(member)) continue;
      processed.add(member);

      // Find original casing from players
      const originalCased = players.find(
        p => p.school && p.school.toLowerCase() === member
      )?.school || member;

      result.push({
        originalName: originalCased,
        normalizedName: titleCase(cluster.canonical),
        schoolId: school.clusterId!,
        playerCount: schoolCounts.get(member) || 0,
      });
    }
  }

  return result;
}

/**
 * Calculate similarity between two school names.
 * Handles common variations like "Elementary", "School", abbreviations, etc.
 */
function schoolNameSimilarity(name1: string, name2: string): number {
  // Normalize both names
  const norm1 = normalizeSchoolName(name1);
  const norm2 = normalizeSchoolName(name2);

  if (norm1 === norm2) return 1;

  // Use Levenshtein-based similarity
  return nameSimilarity(norm1, norm2);
}

/**
 * Normalize a school name for comparison.
 */
function normalizeSchoolName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    // Remove common suffixes
    .replace(/\s+(elementary|elem\.?|school|sch\.?|primary|academy|acad\.?)$/gi, '')
    // Normalize common abbreviations
    .replace(/\belem\.?\b/gi, 'elementary')
    .replace(/\bsch\.?\b/gi, 'school')
    .replace(/\bacad\.?\b/gi, 'academy')
    // Remove punctuation
    .replace(/[.,'-]/g, '')
    // Collapse whitespace
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Convert a string to title case.
 */
function titleCase(str: string): string {
  return str
    .split(' ')
    .map(word => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(' ');
}

// -----------------------------------------------------------------------------
// Sibling Detection by Address
// -----------------------------------------------------------------------------

/**
 * Detect siblings by matching last name AND address.
 * Returns groups of sibling player indices.
 */
export function detectSiblingsByAddress(
  registrations: RegistrationRow[]
): Map<string, number[]> {
  // Group by normalized address + last name
  const groups = new Map<string, number[]>();

  registrations.forEach((reg, index) => {
    if (!reg.address || reg.address.trim() === '') return;

    // Create a key from normalized address + last name
    const normalizedAddress = normalizeAddress(reg.address);
    const key = `${reg.lastName.toLowerCase()}|${normalizedAddress}`;

    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key)!.push(index);
  });

  // Filter to only groups with multiple siblings
  const siblingGroups = new Map<string, number[]>();
  let groupId = 0;

  groups.forEach((indices) => {
    if (indices.length > 1) {
      siblingGroups.set(String.fromCharCode(65 + groupId), indices); // 'A', 'B', 'C', etc.
      groupId++;
    }
  });

  return siblingGroups;
}

/**
 * Normalize an address for comparison
 */
function normalizeAddress(address: string): string {
  return address
    .toLowerCase()
    .trim()
    // Remove common variations
    .replace(/\bstreet\b/g, 'st')
    .replace(/\bavenue\b/g, 'ave')
    .replace(/\bdrive\b/g, 'dr')
    .replace(/\broad\b/g, 'rd')
    .replace(/\bcourt\b/g, 'ct')
    .replace(/\blane\b/g, 'ln')
    .replace(/\bplace\b/g, 'pl')
    .replace(/\bapartment\b/g, 'apt')
    .replace(/\bunit\b/g, 'unit')
    .replace(/[.,#]/g, '')
    .replace(/\s+/g, ' ');
}

// -----------------------------------------------------------------------------
// Date Parsing & Little League Age Calculation
// -----------------------------------------------------------------------------

/**
 * Parse an Excel date value into a JavaScript Date.
 * Excel stores dates as numbers (days since 1900) or as strings.
 */
function parseExcelDateValue(value: unknown): Date | null {
  if (!value) return null;

  // If it's a number, it's an Excel serial date
  if (typeof value === 'number') {
    // Excel serial date: days since January 1, 1900 (with a bug for 1900 leap year)
    const excelEpoch = new Date(1899, 11, 30); // December 30, 1899
    const date = new Date(excelEpoch.getTime() + value * 24 * 60 * 60 * 1000);
    if (!isNaN(date.getTime())) {
      return date;
    }
  }

  // If it's a string, try to parse it
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    // Try standard date parsing
    const parsed = new Date(trimmed);
    if (!isNaN(parsed.getTime())) {
      return parsed;
    }

    // Try MM/DD/YYYY format
    const mmddyyyy = trimmed.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if (mmddyyyy) {
      const [, month, day, year] = mmddyyyy;
      const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
      if (!isNaN(date.getTime())) {
        return date;
      }
    }

    // Try YYYY-MM-DD format
    const yyyymmdd = trimmed.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    if (yyyymmdd) {
      const [, year, month, day] = yyyymmdd;
      const date = new Date(parseInt(year), parseInt(month) - 1, parseInt(day));
      if (!isNaN(date.getTime())) {
        return date;
      }
    }
  }

  // If it's already a Date object
  if (value instanceof Date && !isNaN(value.getTime())) {
    return value;
  }

  return null;
}

/**
 * Calculate Little League Age from birthdate.
 *
 * Little League age is determined by the player's age on August 31 of the league year.
 * The "league year" is the calendar year of the season (e.g., 2026 for Spring 2026).
 */
function calculateLittleLeagueAge(birthdate: Date): number {
  const now = new Date();
  const leagueYear = now.getFullYear();

  // Cutoff date is August 31 of the league year
  const cutoffDate = new Date(leagueYear, 7, 31); // August is month 7 (0-indexed)

  // Calculate age as of the cutoff date
  let age = cutoffDate.getFullYear() - birthdate.getFullYear();

  // Adjust if birthday hasn't occurred yet by the cutoff
  const birthdayThisYear = new Date(cutoffDate.getFullYear(), birthdate.getMonth(), birthdate.getDate());
  if (birthdayThisYear > cutoffDate) {
    age--;
  }

  return age;
}

// -----------------------------------------------------------------------------
// Request Confirmation Data Preparation
// -----------------------------------------------------------------------------

import { ResolvedRequest, RequestCluster, RequestsFirstConfig, DEFAULT_REQUESTS_FIRST_CONFIG } from '../types';

export function countPlayersWithRequests(requests: ResolvedRequest[]): number {
  return new Set(requests.map(request => request.playerId)).size;
}

/**
 * Convert normalized request data into ResolvedRequest format for the confirmation UI.
 * This determines which requests are auto-confirmed vs need review.
 */
export function prepareRequestsForConfirmation(
  normalizationResult: NormalizationResult,
  config: Partial<RequestsFirstConfig> = {}
): ResolvedRequest[] {
  const { autoConfirmThreshold, needsReviewThreshold } = {
    ...DEFAULT_REQUESTS_FIRST_CONFIG,
    ...config,
  };

  const resolvedRequests: ResolvedRequest[] = [];
  let requestId = 0;

  for (const player of normalizationResult.players) {
    // Process coach request
    if (player.rawCoachRequest && player.rawCoachRequest.trim()) {
      const status = determineRequestStatus(
        player.coachMatchScore,
        player.coachRequestStatus,
        autoConfirmThreshold,
        needsReviewThreshold
      );

      resolvedRequests.push({
        id: `req-${requestId++}`,
        playerId: player.id,
        requestType: 'coach',
        rawRequestString: player.rawCoachRequest,
        resolvedTargetId: player.resolvedCoachTeamId,
        resolvedTargetName: player.resolvedCoachName,
        status,
        confidenceScore: player.coachMatchScore,
        isTwoWay: false, // Coach requests can't be two-way
        suggestedMatches: [], // Would be populated from match suggestions
      });
    }

    // Process teammate requests
    for (const resolution of player.teammateResolutions) {
      if (!resolution.rawRequest || !resolution.rawRequest.trim()) continue;

      const status = determineRequestStatus(
        resolution.matchScore,
        resolution.requestStatus,
        autoConfirmThreshold,
        needsReviewThreshold
      );

      resolvedRequests.push({
        id: `req-${requestId++}`,
        playerId: player.id,
        requestType: 'teammate',
        rawRequestString: resolution.rawRequest,
        resolvedTargetId: resolution.resolvedPlayerId,
        resolvedTargetName: resolution.resolvedPlayerName,
        status,
        confidenceScore: resolution.matchScore,
        isTwoWay: resolution.isTwoWay,
        suggestedMatches: resolution.suggestedMatches?.map(m => ({
          id: m.playerId,
          name: m.name,
          score: m.score,
        })),
      });
    }
  }

  return resolvedRequests;
}

/**
 * Determine the confirmation status based on match score and resolution status.
 */
function determineRequestStatus(
  matchScore: number,
  resolutionStatus: 'resolved' | 'possible' | 'impossible' | 'none',
  autoConfirmThreshold: number,
  needsReviewThreshold: number
): ResolvedRequest['status'] {
  if (resolutionStatus === 'impossible' || resolutionStatus === 'none') {
    return 'unresolvable';
  }

  if (resolutionStatus === 'resolved' && matchScore >= autoConfirmThreshold) {
    return 'auto-confirmed';
  }

  if (matchScore >= needsReviewThreshold) {
    return 'needs-review';
  }

  return 'unresolvable';
}

// -----------------------------------------------------------------------------
// Request Cluster Building (Union-Find for Two-Way Groups)
// -----------------------------------------------------------------------------

/**
 * Build clusters of players connected by two-way teammate requests.
 * Uses Union-Find to group connected players.
 */
export function buildRequestClusters(
  resolvedRequests: ResolvedRequest[],
  _players: Array<{ id: string; firstName: string; lastName: string }>,
  maxRosterSize: number = 13
): RequestCluster[] {
  // Filter to only confirmed/auto-confirmed two-way teammate requests
  const twoWayRequests = resolvedRequests.filter(
    req =>
      req.requestType === 'teammate' &&
      req.isTwoWay &&
      req.resolvedTargetId &&
      (req.status === 'auto-confirmed' || req.status === 'user-confirmed')
  );

  if (twoWayRequests.length === 0) {
    return [];
  }

  // Union-Find data structure
  const parent = new Map<string, string>();
  const rank = new Map<string, number>();

  const find = (x: string): string => {
    if (!parent.has(x)) {
      parent.set(x, x);
      rank.set(x, 0);
    }
    if (parent.get(x) !== x) {
      parent.set(x, find(parent.get(x)!));
    }
    return parent.get(x)!;
  };

  const union = (x: string, y: string) => {
    const rootX = find(x);
    const rootY = find(y);
    if (rootX === rootY) return;

    const rankX = rank.get(rootX) || 0;
    const rankY = rank.get(rootY) || 0;

    if (rankX < rankY) {
      parent.set(rootX, rootY);
    } else if (rankX > rankY) {
      parent.set(rootY, rootX);
    } else {
      parent.set(rootY, rootX);
      rank.set(rootX, rankX + 1);
    }
  };

  // Build union-find from two-way requests
  for (const req of twoWayRequests) {
    union(req.playerId, req.resolvedTargetId!);
  }

  // Group players by their root
  const clusterMap = new Map<string, Set<string>>();
  const allPlayerIds = new Set<string>();

  for (const req of twoWayRequests) {
    allPlayerIds.add(req.playerId);
    allPlayerIds.add(req.resolvedTargetId!);
  }

  for (const playerId of allPlayerIds) {
    const root = find(playerId);
    if (!clusterMap.has(root)) {
      clusterMap.set(root, new Set());
    }
    clusterMap.get(root)!.add(playerId);
  }

  // Get coach requests for players to determine preferred teams
  const playerCoachRequests = new Map<string, string>();
  for (const req of resolvedRequests) {
    if (
      req.requestType === 'coach' &&
      req.resolvedTargetId &&
      (req.status === 'auto-confirmed' || req.status === 'user-confirmed')
    ) {
      playerCoachRequests.set(req.playerId, req.resolvedTargetId);
    }
  }

  // Build clusters
  const clusters: RequestCluster[] = [];
  let clusterId = 0;

  for (const [, playerIds] of clusterMap) {
    const idsArray = Array.from(playerIds);
    const warnings: string[] = [];

    // Collect preferred teams from coach requests
    const preferredTeamIds = new Set<string>();
    for (const playerId of idsArray) {
      const teamId = playerCoachRequests.get(playerId);
      if (teamId) {
        preferredTeamIds.add(teamId);
      }
    }

    // Check if cluster is too large
    if (idsArray.length > maxRosterSize) {
      warnings.push(
        `Cluster of ${idsArray.length} players exceeds max roster size of ${maxRosterSize}. ` +
        `Will be split during assignment.`
      );
    }

    // Calculate total weight based on number of two-way connections
    // Each two-way pair within the cluster adds to the weight
    let connectionCount = 0;
    for (const req of twoWayRequests) {
      if (playerIds.has(req.playerId) && playerIds.has(req.resolvedTargetId!)) {
        connectionCount++;
      }
    }
    // Divide by 2 since each connection is counted twice (A→B and B→A)
    const totalWeight = (connectionCount / 2) * 100; // 100 points per two-way pair

    clusters.push({
      id: `cluster-${clusterId++}`,
      playerIds: idsArray,
      preferredTeamIds: Array.from(preferredTeamIds),
      totalWeight,
      warnings,
    });
  }

  // Sort clusters by total weight (descending) and then by size (descending)
  clusters.sort((a, b) => {
    if (b.totalWeight !== a.totalWeight) {
      return b.totalWeight - a.totalWeight;
    }
    return b.playerIds.length - a.playerIds.length;
  });

  return clusters;
}

/**
 * Split a cluster that's too large for one team.
 * Uses a greedy approach to keep the strongest connections together.
 */
export function splitOversizedCluster(
  cluster: RequestCluster,
  resolvedRequests: ResolvedRequest[],
  maxSize: number
): RequestCluster[] {
  if (cluster.playerIds.length <= maxSize) {
    return [cluster];
  }

  // Build a connection strength map between players
  const connectionStrength = new Map<string, Map<string, number>>();

  for (const req of resolvedRequests) {
    if (
      req.requestType === 'teammate' &&
      req.resolvedTargetId &&
      cluster.playerIds.includes(req.playerId) &&
      cluster.playerIds.includes(req.resolvedTargetId)
    ) {
      const fromId = req.playerId;
      const toId = req.resolvedTargetId;

      if (!connectionStrength.has(fromId)) {
        connectionStrength.set(fromId, new Map());
      }
      const current = connectionStrength.get(fromId)!.get(toId) || 0;
      connectionStrength.get(fromId)!.set(toId, current + (req.isTwoWay ? 100 : 50));
    }
  }

  // Greedy partitioning: start with the player who has the most connections
  const result: RequestCluster[] = [];
  const remaining = new Set(cluster.playerIds);
  let subClusterId = 0;

  while (remaining.size > 0) {
    const subCluster = new Set<string>();

    // Find the player with most connections to unassigned players
    let bestStart: string | null = null;
    let bestScore = -1;

    for (const playerId of remaining) {
      let score = 0;
      const connections = connectionStrength.get(playerId);
      if (connections) {
        for (const [targetId, strength] of connections) {
          if (remaining.has(targetId)) {
            score += strength;
          }
        }
      }
      if (score > bestScore) {
        bestScore = score;
        bestStart = playerId;
      }
    }

    // Start with this player
    if (bestStart) {
      subCluster.add(bestStart);
      remaining.delete(bestStart);
    } else if (remaining.size > 0) {
      // Fallback: pick any remaining player
      const first = remaining.values().next().value as string;
      if (first) {
        subCluster.add(first);
        remaining.delete(first);
      }
    }

    // Add connected players until we hit max size
    while (subCluster.size < maxSize && remaining.size > 0) {
      // Find the remaining player most connected to current subcluster
      let bestNext: string | null = null;
      let bestNextScore = -1;

      for (const candidateId of remaining) {
        let score = 0;
        for (const memberId of subCluster) {
          const memberConnections = connectionStrength.get(memberId);
          if (memberConnections) {
            score += memberConnections.get(candidateId) || 0;
          }
          const candidateConnections = connectionStrength.get(candidateId);
          if (candidateConnections) {
            score += candidateConnections.get(memberId) || 0;
          }
        }
        if (score > bestNextScore) {
          bestNextScore = score;
          bestNext = candidateId;
        }
      }

      if (bestNext && bestNextScore > 0) {
        subCluster.add(bestNext);
        remaining.delete(bestNext);
      } else {
        // No more connected players - break and start new cluster
        break;
      }
    }

    // Create the sub-cluster
    const subClusterArray = Array.from(subCluster);
    result.push({
      id: `${cluster.id}-sub${subClusterId++}`,
      playerIds: subClusterArray,
      preferredTeamIds: cluster.preferredTeamIds, // Inherit preferences
      totalWeight: cluster.totalWeight / Math.ceil(cluster.playerIds.length / maxSize),
      warnings: [`Split from larger cluster of ${cluster.playerIds.length} players`],
    });
  }

  return result;
}

/**
 * Update resolved requests based on user confirmations.
 * Returns a new array with updated statuses.
 */
export function applyUserConfirmations(
  requests: ResolvedRequest[],
  confirmations: Map<string, { targetId: string | null; targetName: string | null }>
): ResolvedRequest[] {
  return requests.map(req => {
    const confirmation = confirmations.get(req.id);
    if (!confirmation) return req;

    if (confirmation.targetId === null) {
      // User marked as unresolvable
      return {
        ...req,
        status: 'unresolvable' as const,
        resolvedTargetId: null,
        resolvedTargetName: null,
      };
    }

    return {
      ...req,
      status: 'user-confirmed' as const,
      resolvedTargetId: confirmation.targetId,
      resolvedTargetName: confirmation.targetName,
    };
  });
}

/**
 * Get statistics about request confirmation status.
 */
export function getConfirmationStats(requests: ResolvedRequest[]): {
  total: number;
  autoConfirmed: number;
  needsReview: number;
  userConfirmed: number;
  unresolvable: number;
  coachRequests: number;
  teammateRequests: number;
  twoWayRequests: number;
} {
  const stats = {
    total: requests.length,
    autoConfirmed: 0,
    needsReview: 0,
    userConfirmed: 0,
    unresolvable: 0,
    coachRequests: 0,
    teammateRequests: 0,
    twoWayRequests: 0,
  };

  for (const req of requests) {
    switch (req.status) {
      case 'auto-confirmed':
        stats.autoConfirmed++;
        break;
      case 'needs-review':
        stats.needsReview++;
        break;
      case 'user-confirmed':
        stats.userConfirmed++;
        break;
      case 'unresolvable':
        stats.unresolvable++;
        break;
    }

    if (req.requestType === 'coach') {
      stats.coachRequests++;
    } else {
      stats.teammateRequests++;
      if (req.isTwoWay) {
        stats.twoWayRequests++;
      }
    }
  }

  return stats;
}
