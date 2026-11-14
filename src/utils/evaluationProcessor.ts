import {
  ImportedWorkbook,
  ImportedTab,
  EvaluationPlayer,
  EvaluationCategory,
  FieldWeight,
  ImportWarning,
  EVALUATION_TAB_CONFIGS,
  DEFAULT_FIELD_WEIGHTS,
} from '../types/evaluation';
import { Player } from '../types';
import { toCSVRow } from './exports';
import {
  normalizeScore,
  getBestTime,
  weightedAverage,
  roundScore,
  calculateTimeRange,
} from './scoreNormalization';

/**
 * Process an imported workbook into EvaluationPlayer array
 */
export function processWorkbook(
  workbook: ImportedWorkbook,
  fieldWeights: FieldWeight[] = DEFAULT_FIELD_WEIGHTS
): { players: EvaluationPlayer[]; warnings: ImportWarning[] } {
  const warnings: ImportWarning[] = [];

  // First, collect all times to calculate dynamic range
  const allTimes: number[] = [];
  for (const tab of workbook.tabs) {
    if (tab.matchedConfig?.category === 'baserunning') {
      for (const row of tab.rows) {
        if (row.scores.time1) allTimes.push(row.scores.time1);
        if (row.scores.time2) allTimes.push(row.scores.time2);
      }
    }
  }
  const timeRange = calculateTimeRange(allTimes);

  // Build player map keyed by BIB
  const playerMap = new Map<string, EvaluationPlayer>();

  // Initialize all players from the union of BIBs
  for (const bib of workbook.allBibs) {
    playerMap.set(bib, createEmptyPlayer(bib));
  }

  // Process each tab and merge data into players
  for (const tab of workbook.tabs) {
    // Special handling for combined Summary tab
    if (tab.isCombinedTab) {
      processCombinedTab(tab, playerMap, timeRange, warnings);
      continue;
    }

    if (!tab.matchedConfig) {
      warnings.push({
        type: 'partial_data',
        message: `Tab "${tab.name}" not recognized as an evaluation category`,
        tab: tab.name,
      });
      continue;
    }

    const category = tab.matchedConfig.category;

    for (const row of tab.rows) {
      const player = playerMap.get(row.bib);
      if (!player) continue;

      // Update player info if available
      if (row.firstName && !player.firstName) {
        player.firstName = row.firstName;
      }
      if (row.lastName && !player.lastName) {
        player.lastName = row.lastName;
      }
      if (row.age && !player.age) {
        player.age = row.age;
      }
      if (row.level && !player.level) {
        player.level = row.level;
      }

      // Track which tabs we found this player in
      if (!player.tabsFound.includes(tab.name)) {
        player.tabsFound.push(tab.name);
      }

      // Store raw scores
      player.rawScores[category] = { ...row.scores };

      // Normalize scores based on field config
      const config = tab.matchedConfig;
      const normalizedScores: Record<string, number> = {};

      for (const field of config.fields) {
        const rawValue = row.scores[field.name];

        // Special handling for baserunning times - use best time
        if (category === 'baserunning' && (field.name === 'time1' || field.name === 'time2')) {
          // Skip individual times - we'll handle bestTime separately
          continue;
        }

        const normalized = normalizeScore(
          rawValue,
          field.inputMin,
          field.inputMax,
          field.lowerIsBetter
        );

        if (normalized !== null) {
          normalizedScores[field.name] = normalized;
        } else if (rawValue !== null && rawValue !== undefined) {
          warnings.push({
            type: 'invalid_score',
            message: `Invalid ${field.name} score for BIB ${row.bib}: ${rawValue}`,
            bib: row.bib,
            tab: tab.name,
          });
        }
      }

      // Handle baserunning best time
      if (category === 'baserunning') {
        const bestTime = getBestTime(row.scores.time1, row.scores.time2);
        if (bestTime !== null) {
          // Use dynamic time range for normalization
          const normalized = normalizeScore(bestTime, timeRange.min, timeRange.max, true);
          if (normalized !== null) {
            normalizedScores['bestTime'] = normalized;
          }
        }
      }

      player.normalizedScores[category] = normalizedScores;
    }
  }

  // Calculate category scores and weighted totals
  const players = Array.from(playerMap.values());

  for (const player of players) {
    // Update full name
    player.fullName =
      player.firstName && player.lastName
        ? `${player.firstName} ${player.lastName}`.trim()
        : player.bib;

    // Calculate category scores and weighted total
    calculatePlayerScores(player, fieldWeights);

    // Track missing categories
    for (const category of Object.keys(player.categoryScores) as EvaluationCategory[]) {
      if (player.categoryScores[category] === null) {
        player.missingCategories.push(category);
      }
    }

    // Mark as partial if missing data OR if no evaluation data at all
    // A player is DNE if they have no tabs found OR if they're missing ALL categories
    const isMissingAllCategories = player.missingCategories.length === 5; // All 5 categories missing
    player.isPartial = player.missingCategories.length > 0 || player.tabsFound.length === 0;
    player.isDNE = player.tabsFound.length === 0 || isMissingAllCategories;

    // Only warn about partial data if they have SOME data but not all categories
    // Don't warn for players who are completely DNE (will be handled separately)
    if (player.missingCategories.length > 0 && player.tabsFound.length > 0 && !isMissingAllCategories) {
      warnings.push({
        type: 'partial_data',
        message: `Player ${player.fullName} (BIB ${player.bib}) missing categories: ${player.missingCategories.join(', ')}`,
        bib: player.bib,
      });
    }
  }

  // Collect players with no evaluation data (either no tabs found OR missing all categories)
  const noEvalPlayers = players.filter(p => p.isDNE);
  if (noEvalPlayers.length > 0) {
    const playerList = noEvalPlayers.map(p => `${p.fullName} (BIB ${p.bib})`).join(', ');
    warnings.push({
      type: 'no_evaluation',
      message: `${noEvalPlayers.length} player(s) marked as DNE (Did Not Evaluate) - no scores recorded: ${playerList}`,
      bib: noEvalPlayers[0].bib,
    });
  }

  // Merge littleLeagueAge from registration data if available
  if (workbook.registrationData) {
    for (const player of players) {
      // Find matching registration record by name
      const regRecord = workbook.registrationData.find(
        r => r.firstName.toLowerCase() === player.firstName.toLowerCase() &&
             r.lastName.toLowerCase() === player.lastName.toLowerCase()
      );
      if (regRecord?.littleLeagueAge) {
        player.littleLeagueAge = regRecord.littleLeagueAge;
      }
    }
  }

  // Sort by weighted total (descending) and assign ranks
  players.sort((a, b) => b.weightedTotal - a.weightedTotal);
  players.forEach((player, index) => {
    player.rank = index + 1;
  });

  return { players, warnings };
}

/**
 * Process a combined Summary tab that contains all evaluation categories
 */
function processCombinedTab(
  tab: ImportedTab,
  playerMap: Map<string, EvaluationPlayer>,
  timeRange: { min: number; max: number },
  _warnings: ImportWarning[]
): void {
  for (const row of tab.rows) {
    const player = playerMap.get(row.bib);
    if (!player) continue;

    // Update player info
    if (row.firstName && !player.firstName) {
      player.firstName = row.firstName;
    }
    if (row.lastName && !player.lastName) {
      player.lastName = row.lastName;
    }

    // Track tab
    if (!player.tabsFound.includes(tab.name)) {
      player.tabsFound.push(tab.name);
    }

    // Store raw scores by category
    // Fielding
    player.rawScores.fielding = {
      field: row.scores['field'] ?? null,
      throw: row.scores['throw'] ?? null,
    };
    // Fly Balls
    player.rawScores.flyBalls = {
      form: row.scores['flyBallForm'] ?? null,
      catches: row.scores['catches'] ?? null,
    };
    // Baserunning
    player.rawScores.baserunning = {
      form: row.scores['baserunningForm'] ?? null,
      time1: row.scores['time1'] ?? null,
      time2: row.scores['time2'] ?? null,
    };
    // Pitching
    player.rawScores.pitching = {
      form: row.scores['pitchingForm'] ?? null,
      armStrength: row.scores['armStrength'] ?? null,
    };
    // Hitting
    player.rawScores.hitting = {
      form: row.scores['hittingForm'] ?? null,
      contactPower: row.scores['contactPower'] ?? null,
      hits: row.scores['hits'] ?? null,
    };

    // Normalize scores
    // Fielding (0-5 scale based on your data)
    const fieldNorm = normalizeScore(row.scores['field'], 0, 5, false);
    const throwNorm = normalizeScore(row.scores['throw'], 0, 5, false);
    if (fieldNorm !== null) player.normalizedScores.fielding['field'] = fieldNorm;
    if (throwNorm !== null) player.normalizedScores.fielding['throw'] = throwNorm;

    // Fly Balls
    const flyBallFormNorm = normalizeScore(row.scores['flyBallForm'], 0, 4, false);
    const catchesNorm = normalizeScore(row.scores['catches'], 0, 3, false);
    if (flyBallFormNorm !== null) player.normalizedScores.flyBalls['form'] = flyBallFormNorm;
    if (catchesNorm !== null) player.normalizedScores.flyBalls['catches'] = catchesNorm;

    // Baserunning
    const baserunningFormNorm = normalizeScore(row.scores['baserunningForm'], 0, 4, false);
    if (baserunningFormNorm !== null) player.normalizedScores.baserunning['form'] = baserunningFormNorm;
    // Handle best time
    const bestTime = getBestTime(row.scores['time1'], row.scores['time2']);
    if (bestTime !== null) {
      const timeNorm = normalizeScore(bestTime, timeRange.min, timeRange.max, true);
      if (timeNorm !== null) player.normalizedScores.baserunning['bestTime'] = timeNorm;
    }

    // Pitching
    const pitchingFormNorm = normalizeScore(row.scores['pitchingForm'], 0, 4, false);
    const armStrengthNorm = normalizeScore(row.scores['armStrength'], 0, 4, false);
    if (pitchingFormNorm !== null) player.normalizedScores.pitching['form'] = pitchingFormNorm;
    if (armStrengthNorm !== null) player.normalizedScores.pitching['armStrength'] = armStrengthNorm;

    // Hitting
    const hittingFormNorm = normalizeScore(row.scores['hittingForm'], 0, 4, false);
    const contactPowerNorm = normalizeScore(row.scores['contactPower'], 0, 4, false);
    const hitsNorm = normalizeScore(row.scores['hits'], 0, 5, false);
    if (hittingFormNorm !== null) player.normalizedScores.hitting['form'] = hittingFormNorm;
    if (contactPowerNorm !== null) player.normalizedScores.hitting['contactPower'] = contactPowerNorm;
    if (hitsNorm !== null) player.normalizedScores.hitting['hits'] = hitsNorm;
  }
}

/**
 * Create an empty player structure
 */
function createEmptyPlayer(bib: string): EvaluationPlayer {
  return {
    bib,
    firstName: '',
    lastName: '',
    fullName: '',
    age: 0,
    level: '',
    rawScores: {
      fielding: {},
      pitching: {},
      hitting: {},
      flyBalls: {},
      baserunning: {},
    },
    normalizedScores: {
      fielding: {},
      pitching: {},
      hitting: {},
      flyBalls: {},
      baserunning: {},
    },
    categoryScores: {
      fielding: null,
      pitching: null,
      hitting: null,
      flyBalls: null,
      baserunning: null,
    },
    manualAdjust: 0,
    weightedTotal: 0,
    rank: 0,
    projectedRound: 0,
    isCoachKid: false,
    coachTeamIndex: null,
    siblingGroupId: null,
    isAllStar: false,
    missingCategories: [],
    tabsFound: [],
    isPartial: false,
    isDNE: false,
  };
}

/**
 * Field mapping from fieldId to normalized score location
 */
export const FIELD_MAPPING: Record<string, { category: EvaluationCategory; field: string }> = {
  'pitchingForm': { category: 'pitching', field: 'form' },
  'armStrength': { category: 'pitching', field: 'armStrength' },
  'hittingForm': { category: 'hitting', field: 'form' },
  'contactPower': { category: 'hitting', field: 'contactPower' },
  'hits': { category: 'hitting', field: 'hits' },
  'field': { category: 'fielding', field: 'field' },
  'throw': { category: 'fielding', field: 'throw' },
  'catches': { category: 'flyBalls', field: 'catches' },
  'flyBallForm': { category: 'flyBalls', field: 'form' },
  'bestTime': { category: 'baserunning', field: 'bestTime' },
  'baserunningForm': { category: 'baserunning', field: 'form' },
};

/**
 * Map fieldId to the actual score location in normalizedScores
 */
export function getFieldScore(player: EvaluationPlayer, fieldId: string): number | null {
  const mapping = FIELD_MAPPING[fieldId];
  if (!mapping) return null;

  return player.normalizedScores[mapping.category]?.[mapping.field] ?? null;
}

/**
 * Calculate player scores using field-level weights
 */
function calculatePlayerScores(player: EvaluationPlayer, fieldWeights: FieldWeight[]): void {
  let weightedSum = 0;
  let totalWeight = 0;

  // Calculate weighted total directly from field weights
  for (const fw of fieldWeights) {
    if (!fw.enabled) continue;

    const score = getFieldScore(player, fw.fieldId);

    if (score !== null) {
      weightedSum += score * (fw.weight / 100);
      totalWeight += fw.weight;
    }
  }

  // Redistribute weights if some fields are missing data
  if (totalWeight > 0 && totalWeight < 100) {
    player.weightedTotal = roundScore((weightedSum / totalWeight) * 100, 1) ?? 0;
  } else {
    player.weightedTotal = roundScore(weightedSum, 1) ?? 0;
  }

  // Apply manual adjustment
  player.weightedTotal = roundScore(player.weightedTotal + player.manualAdjust, 1) ?? 0;

  // Also calculate category scores for display purposes
  calculateCategoryScoresForDisplay(player);
}

/**
 * Calculate category scores for display (average of normalized scores within each category)
 */
function calculateCategoryScoresForDisplay(player: EvaluationPlayer): void {
  for (const config of EVALUATION_TAB_CONFIGS) {
    const category = config.category;
    const normalized = player.normalizedScores[category];

    if (!normalized || Object.keys(normalized).length === 0) {
      player.categoryScores[category] = null;
      continue;
    }

    // Calculate simple average within category for display
    const fieldScores: { value: number | null; weight: number }[] = [];

    for (const field of config.fields) {
      // Special handling for baserunning - use bestTime instead of time1/time2
      if (category === 'baserunning' && (field.name === 'time1' || field.name === 'time2')) {
        continue;
      }

      const fieldName = category === 'baserunning' && field.name.includes('time') ? 'bestTime' : field.name;
      const value = normalized[fieldName] ?? null;

      fieldScores.push({ value, weight: field.weight });
    }

    // Add bestTime for baserunning with combined time weight
    if (category === 'baserunning' && normalized['bestTime'] !== undefined) {
      const timeWeight = config.fields
        .filter((f) => f.name === 'time1' || f.name === 'time2')
        .reduce((sum, f) => sum + f.weight, 0);
      fieldScores.push({ value: normalized['bestTime'], weight: timeWeight });
    }

    const categoryScore = weightedAverage(fieldScores);
    player.categoryScores[category] = categoryScore !== null ? roundScore(categoryScore, 1) : null;
  }
}

/**
 * Recalculate all player scores with new weights
 */
export function recalculateWithWeights(
  players: EvaluationPlayer[],
  fieldWeights: FieldWeight[]
): EvaluationPlayer[] {
  const updatedPlayers = players.map((player) => {
    const updated = { ...player };
    calculatePlayerScores(updated, fieldWeights);
    return updated;
  });

  // Re-sort and re-rank
  updatedPlayers.sort((a, b) => b.weightedTotal - a.weightedTotal);
  updatedPlayers.forEach((player, index) => {
    player.rank = index + 1;
  });

  return updatedPlayers;
}

/**
 * Convert EvaluationPlayer array to Player array for draft system
 */
export function convertToPlayers(
  evalPlayers: EvaluationPlayer[],
  teamCount: number,
  teamIds: string[] = []
): Player[] {
  // Build sibling mapping: siblingGroupId → array of bibs
  const siblingGroups = new Map<string, string[]>();
  evalPlayers.forEach(ep => {
    if (ep.siblingGroupId) {
      const group = siblingGroups.get(ep.siblingGroupId) || [];
      group.push(ep.bib);
      siblingGroups.set(ep.siblingGroupId, group);
    }
  });

  // Generate stable IDs based on bib (no timestamp to allow sibling linking)
  const bibToId = new Map<string, string>();
  evalPlayers.forEach(ep => {
    bibToId.set(ep.bib, `player-${ep.bib}`);
  });

  return evalPlayers.map((ep) => {
    // Find sibling info
    let siblingId: string | undefined;
    let siblingName: string | undefined;
    if (ep.siblingGroupId) {
      const group = siblingGroups.get(ep.siblingGroupId);
      const siblingBib = group?.find(bib => bib !== ep.bib);
      if (siblingBib) {
        siblingId = bibToId.get(siblingBib);
        const siblingPlayer = evalPlayers.find(p => p.bib === siblingBib);
        siblingName = siblingPlayer?.fullName || siblingBib;
      }
    }

    // Get coach team ID if assigned
    const coachTeamId = ep.isCoachKid && ep.coachTeamIndex !== null && teamIds[ep.coachTeamIndex]
      ? teamIds[ep.coachTeamIndex]
      : undefined;

    const player: Player = {
      id: bibToId.get(ep.bib) || `player-${ep.bib}`,
      bib: ep.bib,
      firstName: ep.firstName || '',
      lastName: ep.lastName || '',
      name: ep.fullName || ep.bib,

      // Map normalized evaluation scores to raw component fields
      // These are the weighted contributions that sum to totalScore
      fieldScore: ep.normalizedScores.fielding?.field ?? 0,
      throwScore: ep.normalizedScores.fielding?.throw ?? 0,
      hitPower: ep.normalizedScores.hitting?.contactPower ?? 0,
      hitForm: ep.normalizedScores.hitting?.form ?? 0,
      hitContact: ep.normalizedScores.hitting?.hits ?? 0,
      pitchingStrength: ep.normalizedScores.pitching?.armStrength ?? 0,
      pitchingForm: ep.normalizedScores.pitching?.form ?? 0,
      // Catch score combines fly ball catches + fly ball form
      catchScore: (ep.normalizedScores.flyBalls?.catches ?? 0) + (ep.normalizedScores.flyBalls?.form ?? 0),
      // Running score combines best time + baserunning form
      runningScore: (ep.normalizedScores.baserunning?.bestTime ?? 0) + (ep.normalizedScores.baserunning?.form ?? 0),

      // Map category scores to subtotals
      fieldingSubtotal: ep.categoryScores.fielding ?? 0,
      hittingSubtotal: ep.categoryScores.hitting ?? 0,
      pitchingSubtotal: ep.categoryScores.pitching ?? 0,

      // Use fly balls and baserunning for catch and running scores
      subjectiveTotal:
        (ep.categoryScores.fielding ?? 0) +
        (ep.categoryScores.hitting ?? 0) +
        (ep.categoryScores.pitching ?? 0),
      objectiveTotal:
        (ep.categoryScores.flyBalls ?? 0) + (ep.categoryScores.baserunning ?? 0),
      officialAdjust: ep.manualAdjust,

      totalScore: ep.weightedTotal,
      rank: ep.rank,
      projectedRound: Math.ceil(ep.rank / teamCount),

      // Player info
      littleLeagueAge: ep.age || 0,
      birthday: '',
      isAllStar: ep.isAllStar,
      isDNE: ep.isPartial,

      // Coach kid and sibling data - transferred from evaluation
      isCoachKid: ep.isCoachKid,
      coachTeamId,
      sibling: siblingName,
      siblingId,

      // Draft status
      isDrafted: false,
    };

    return player;
  });
}

/**
 * Generate summary CSV from processed players with weighted contribution values
 * Values match what's displayed in the UI table (weighted contributions that sum to Total)
 */
export function generateEvaluationCSV(
  players: EvaluationPlayer[],
  teamNames: string[] = [],
  fieldWeights: FieldWeight[] = DEFAULT_FIELD_WEIGHTS
): string {
  // Helper to get weight for a field
  const getWeight = (fieldId: string): number => {
    const fw = fieldWeights.find(w => w.fieldId === fieldId);
    return fw?.enabled ? fw.weight : 0;
  };

  // Helper to get weighted contribution (normalized * weight / 100)
  const getWeightedValue = (player: EvaluationPlayer, fieldId: string): string => {
    const score = getFieldScore(player, fieldId);
    if (score === null) return '';
    const weight = getWeight(fieldId);
    if (weight === 0) return '';
    const value = (score * weight) / 100;
    return value > 0 ? value.toFixed(1) : '';
  };

  const headers = [
    'Rank',
    'Projected Round',
    'Bib Number',
    'First Name',
    'Last Name',
    'Little League Age',
    'All-Star',
    'Coach Kid',
    'Team',
    'Sibling Group',
    // Pitching fields with weights
    `Pitching Form (${getWeight('pitchingForm')}%)`,
    `Pitching Arm Strength (${getWeight('armStrength')}%)`,
    // Hitting fields with weights
    `Hitting Form (${getWeight('hittingForm')}%)`,
    `Hit Power (${getWeight('contactPower')}%)`,
    `Hit Contact (${getWeight('hits')}%)`,
    // Fielding fields with weights
    `Field Score (${getWeight('field')}%)`,
    `Throw Score (${getWeight('throw')}%)`,
    // Fly Balls fields with weights
    `Catch Score (${getWeight('catches')}%)`,
    `Fly Ball Form (${getWeight('flyBallForm')}%)`,
    // Baserunning fields with weights
    `Running Time (${getWeight('bestTime')}%)`,
    `Running Form (${getWeight('baserunningForm')}%)`,
    // Totals
    'Official Adjust',
    'Total Score',
  ];

  const rows = players.map((p) => [
    p.rank.toString(),
    p.projectedRound.toString(),
    p.bib,
    p.firstName,
    p.lastName,
    p.age?.toString() || '',
    p.isAllStar ? 'Yes' : '',
    p.isCoachKid ? 'Yes' : '',
    p.coachTeamIndex !== null && teamNames[p.coachTeamIndex] ? teamNames[p.coachTeamIndex] : '',
    p.siblingGroupId || '',
    // Pitching - weighted contributions
    getWeightedValue(p, 'pitchingForm'),
    getWeightedValue(p, 'armStrength'),
    // Hitting - weighted contributions
    getWeightedValue(p, 'hittingForm'),
    getWeightedValue(p, 'contactPower'),
    getWeightedValue(p, 'hits'),
    // Fielding - weighted contributions
    getWeightedValue(p, 'field'),
    getWeightedValue(p, 'throw'),
    // Fly Balls - weighted contributions
    getWeightedValue(p, 'catches'),
    getWeightedValue(p, 'flyBallForm'),
    // Baserunning - weighted contributions
    getWeightedValue(p, 'bestTime'),
    getWeightedValue(p, 'baserunningForm'),
    // Totals
    p.manualAdjust.toString(),
    p.weightedTotal.toFixed(1),
  ]);

  return [toCSVRow(headers), ...rows.map(toCSVRow)].join('\n');
}

// Re-export downloadCSV as downloadEvaluationCSV for backwards compatibility
export { downloadCSV as downloadEvaluationCSV } from './exports';
