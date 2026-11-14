import Papa from 'papaparse';
import { CSVRow, Player, Team, ParsedCSVData, ColumnMapping, DEFAULT_SCORING_WEIGHTS, ScoringMode, ScoringWeights } from '../types';
import { calculatePlayerScore, calculatePreWeightedScores } from './scoreCalculation';
import { neutralizeFormula } from './exports';

// Coach assignment extracted from CSV
export interface CoachAssignment {
  playerIndex: number;
  playerId: string;
  playerName: string;
  teamName: string;
  role: 'manager' | 'assistant';
  assistantName?: string; // For teamColumn format: tracks assistant coach name
}

// Result of parsing CSV with mapping
export interface ParsedCSVResult {
  players: Player[];
  coachAssignments: CoachAssignment[];
}

export const parseCSVFile = (file: File): Promise<ParsedCSVData> => {
  return new Promise((resolve, reject) => {
    Papa.parse(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        resolve({
          headers: results.meta.fields || [],
          rows: results.data as Record<string, string>[],
        });
      },
      error: (error) => {
        reject(error);
      },
    });
  });
};

export const parseCSVWithMapping = (
  csvData: ParsedCSVData,
  mapping: ColumnMapping,
  teamCount: number = 8,
  scoringMode: ScoringMode = 'pre-weighted',
  weights: ScoringWeights = DEFAULT_SCORING_WEIGHTS
): ParsedCSVResult => {
  const coachAssignments: CoachAssignment[] = [];

  const players: Player[] = csvData.rows.map((row, index) => {
    // Helper function to get mapped value
    const getMappedValue = (field: string): string => {
      const csvColumn = Object.keys(mapping).find((col) => mapping[col] === field);
      return csvColumn ? (row[csvColumn] || '').toString().trim() : '';
    };

    const bib = getMappedValue('bib') || `BIB-${index + 1}`;
    const firstName = getMappedValue('firstName');
    const lastName = getMappedValue('lastName');
    const fullName = `${firstName} ${lastName}`.trim();

    // Parse raw component scores (optional)
    const fieldScore = parseFloat(getMappedValue('fieldScore')) || 0;
    const throwScore = parseFloat(getMappedValue('throwScore')) || 0;
    const hitPower = parseFloat(getMappedValue('hitPower')) || 0;
    const hitForm = parseFloat(getMappedValue('hitForm')) || 0;
    const hitContact = parseFloat(getMappedValue('hitContact')) || 0;
    const pitchingStrength = parseFloat(getMappedValue('pitchingStrength')) || 0;
    const pitchingForm = parseFloat(getMappedValue('pitchingForm')) || 0;
    // Catch score combines catches + fly ball form (if both mapped)
    const catchScoreBase = parseFloat(getMappedValue('catchScore')) || 0;
    const flyBallForm = parseFloat(getMappedValue('flyBallForm')) || 0;
    const catchScore = catchScoreBase + flyBallForm;
    // Running score combines running/time + running form (if both mapped)
    const runningScoreBase = parseFloat(getMappedValue('runningScore')) || 0;
    const runningForm = parseFloat(getMappedValue('runningForm')) || 0;
    const runningScore = runningScoreBase + runningForm;
    const officialAdjust = parseFloat(getMappedValue('officialAdjust')) || 0;

    // Parse imported subtotals (optional, for validation or fallback)
    const importedFieldingSubtotal = parseFloat(getMappedValue('fieldingSubtotal')) || 0;
    const importedHittingSubtotal = parseFloat(getMappedValue('hittingSubtotal')) || 0;
    const importedPitchingSubtotal = parseFloat(getMappedValue('pitchingSubtotal')) || 0;

    // Parse direct total score (required field now)
    const importedTotalScore = parseFloat(getMappedValue('totalScore')) || 0;

    // Check if we have raw component scores
    const hasRawScores =
      fieldScore > 0 || throwScore > 0 ||
      hitPower > 0 || hitForm > 0 || hitContact > 0 ||
      pitchingStrength > 0 || pitchingForm > 0;

    const hasImportedSubtotals =
      importedFieldingSubtotal > 0 ||
      importedHittingSubtotal > 0 ||
      importedPitchingSubtotal > 0;

    let fieldingSubtotal: number;
    let hittingSubtotal: number;
    let pitchingSubtotal: number;
    let subjectiveTotal: number;
    let objectiveTotal: number;
    let totalScore: number;

    if (hasRawScores) {
      // Option 1: Calculate from raw component scores
      const playerScoreData = {
        fieldScore,
        throwScore,
        hitPower,
        hitForm,
        hitContact,
        pitchingStrength,
        pitchingForm,
        catchScore,
        runningScore,
        officialAdjust,
      };

      // Use appropriate calculation based on scoring mode
      const calculated = scoringMode === 'pre-weighted'
        ? calculatePreWeightedScores(playerScoreData)
        : calculatePlayerScore(playerScoreData, weights);

      fieldingSubtotal = calculated.fieldingSubtotal;
      hittingSubtotal = calculated.hittingSubtotal;
      pitchingSubtotal = calculated.pitchingSubtotal;
      subjectiveTotal = calculated.subjectiveTotal;
      objectiveTotal = calculated.objectiveTotal;
      totalScore = calculated.totalScore;

      // Validation: Compare calculated vs imported (if imported values also exist, only for raw mode)
      if (scoringMode === 'raw' && hasImportedSubtotals) {
        const fieldingDiff = Math.abs(fieldingSubtotal - importedFieldingSubtotal);
        const hittingDiff = Math.abs(hittingSubtotal - importedHittingSubtotal);
        const pitchingDiff = Math.abs(pitchingSubtotal - importedPitchingSubtotal);

        if (fieldingDiff > 0.1 || hittingDiff > 0.1 || pitchingDiff > 0.1) {
          console.warn(`Score discrepancy for ${fullName}:`, {
            fielding: { calculated: fieldingSubtotal, imported: importedFieldingSubtotal, diff: fieldingDiff },
            hitting: { calculated: hittingSubtotal, imported: importedHittingSubtotal, diff: hittingDiff },
            pitching: { calculated: pitchingSubtotal, imported: importedPitchingSubtotal, diff: pitchingDiff },
          });
        }
      }
    } else if (hasImportedSubtotals) {
      // Option 2: Use imported subtotals (legacy format without raw scores)
      fieldingSubtotal = importedFieldingSubtotal;
      hittingSubtotal = importedHittingSubtotal;
      pitchingSubtotal = importedPitchingSubtotal;
      subjectiveTotal = fieldingSubtotal + hittingSubtotal + pitchingSubtotal;
      objectiveTotal = catchScore + runningScore;
      totalScore = subjectiveTotal + objectiveTotal + officialAdjust;
    } else {
      // Option 3: Use direct totalScore (simplest case - just bib, name, and overall score)
      fieldingSubtotal = 0;
      hittingSubtotal = 0;
      pitchingSubtotal = 0;
      subjectiveTotal = 0;
      objectiveTotal = catchScore + runningScore;
      // Use imported total score if available, otherwise calculate from components
      totalScore = importedTotalScore > 0 ? importedTotalScore : (objectiveTotal + officialAdjust);
    }

    // Parse player info
    const littleLeagueAge = parseInt(getMappedValue('littleLeagueAge')) || 0;
    const birthday = getMappedValue('birthday');
    const isAllStar = getMappedValue('isAllStar').toUpperCase() === 'TRUE';
    const isDNE = getMappedValue('isDNE').toUpperCase() === 'TRUE';

    // Parse draft rules (optional)
    const isCoachKid = getMappedValue('isCoachKid').toUpperCase() === 'TRUE';
    const coachTeam = getMappedValue('coachTeam') || undefined; // Team name for coach kid assignment
    const sibling = getMappedValue('sibling') || undefined;
    const school = getMappedValue('school') || undefined; // School name for clustering

    // Parse team assignments from CSV (for coach import)
    const managerTeam = getMappedValue('managerTeam');
    const assistantTeam = getMappedValue('assistantTeam');

    // Generate player ID here so we can use it for coach assignments
    const playerId = `player-${index}-${Date.now()}`;

    // If player is marked as coach kid with a team assignment, record it
    if (isCoachKid && coachTeam) {
      coachAssignments.push({
        playerIndex: index,
        playerId,
        playerName: fullName,
        teamName: coachTeam,
        role: 'manager', // Treat as manager's kid for team matching
      });
    }

    // Parse new "Team" column format: "Manager, Assistant"
    const teamColumn = getMappedValue('teamColumn');
    if (teamColumn && teamColumn.trim()) {
      const parts = teamColumn.split(',').map(s => s.trim()).filter(Boolean);
      if (parts.length > 0) {
        const managerName = parts[0];
        const assistantName = parts[1] || undefined;

        // Add assignment with team info
        coachAssignments.push({
          playerIndex: index,
          playerId,
          playerName: fullName,
          teamName: managerName, // Team name = manager's last name
          role: 'manager', // All teamColumn entries track team creation
          assistantName, // Track assistant for auto-detection
        });
      }
    }

    // Legacy: Collect coach assignments from separate columns
    if (managerTeam) {
      coachAssignments.push({
        playerIndex: index,
        playerId,
        playerName: fullName,
        teamName: managerTeam,
        role: 'manager',
      });
    }
    if (assistantTeam) {
      coachAssignments.push({
        playerIndex: index,
        playerId,
        playerName: fullName,
        teamName: assistantTeam,
        role: 'assistant',
      });
    }

    return {
      id: playerId,
      bib,
      firstName,
      lastName,
      name: fullName,
      // Raw scores
      fieldScore,
      throwScore,
      hitPower,
      hitForm,
      hitContact,
      pitchingStrength,
      pitchingForm,
      catchScore,
      runningScore,
      // Calculated scores
      fieldingSubtotal,
      hittingSubtotal,
      pitchingSubtotal,
      subjectiveTotal,
      objectiveTotal,
      officialAdjust,
      totalScore,
      rank: 0, // Will be calculated after sorting
      projectedRound: 0, // Will be calculated after sorting
      littleLeagueAge,
      birthday,
      isAllStar,
      isDNE,
      isCoachKid,
      sibling,
      school,
      isDrafted: false,
    };
  });

  // Sort by total score (descending) and assign ranks
  const sortedPlayers = players
    .sort((a, b) => b.totalScore - a.totalScore)
    .map((player, index) => ({
      ...player,
      rank: index + 1,
      projectedRound: Math.ceil((index + 1) / teamCount),
    }));

  return {
    players: sortedPlayers,
    coachAssignments,
  };
};

// Legacy function for backward compatibility
export const parseCSV = (file: File): Promise<Player[]> => {
  return new Promise((resolve, reject) => {
    Papa.parse<CSVRow>(file, {
      header: true,
      skipEmptyLines: true,
      complete: (results) => {
        try {
          const players: Player[] = results.data.map((row, index) => {
            const firstName = row['First Name']?.trim() || '';
            const lastName = row['Last Name']?.trim() || '';
            const fullName = `${firstName} ${lastName}`.trim();

            // Parse skill subtotals (legacy format - these are already calculated)
            const fieldingSubtotal = parseFloat(row['FIELDING SUBTOTAL']) || 0;
            const hittingSubtotal = parseFloat(row['HITTING SUBTOTAL']) || 0;
            const pitchingSubtotal = parseFloat(row['PITCHING SUBTOTAL']) || 0;
            const catchScore = parseFloat(row['CATCH SCORE']) || 0;
            const runningScore = parseFloat(row['RUNNING Score']) || 0;
            const officialAdjust = parseFloat(row['Official Adjust']) || 0;

            // Calculate total score
            const totalScore =
              fieldingSubtotal +
              hittingSubtotal +
              pitchingSubtotal +
              catchScore +
              runningScore +
              officialAdjust;

            // Parse player info
            const littleLeagueAge = parseInt(row['Little League Age']) || 0;
            const birthday = row['Birthday']?.trim() || '';
            const isAllStar = row['All-Star']?.toUpperCase() === 'TRUE';
            const isDNE = row['DNE']?.toUpperCase() === 'TRUE';

            // Parse draft rules
            const isCoachKid = row['Coach Kid']?.toUpperCase() === 'TRUE';
            const sibling = row['Sibling']?.trim() || undefined;

            return {
              id: `player-${index}-${Date.now()}`,
              bib: `BIB-${index + 1}`, // Auto-generate bib for legacy format
              firstName,
              lastName,
              name: fullName,
              // Raw scores not available in legacy format - set to 0
              fieldScore: 0,
              throwScore: 0,
              hitPower: 0,
              hitForm: 0,
              hitContact: 0,
              pitchingStrength: 0,
              pitchingForm: 0,
              catchScore,
              runningScore,
              // Use imported subtotals for legacy format
              fieldingSubtotal,
              hittingSubtotal,
              pitchingSubtotal,
              subjectiveTotal: fieldingSubtotal + hittingSubtotal + pitchingSubtotal,
              objectiveTotal: catchScore + runningScore,
              officialAdjust,
              totalScore,
              rank: 0, // Will be calculated after sorting
              projectedRound: 0, // Will be calculated after sorting
              littleLeagueAge,
              birthday,
              isAllStar,
              isDNE,
              isCoachKid,
              sibling,
              isDrafted: false,
            };
          });

          // Sort by total score (descending) and assign ranks
          const sortedPlayers = players
            .sort((a, b) => b.totalScore - a.totalScore)
            .map((player, index) => ({
              ...player,
              rank: index + 1,
              projectedRound: Math.ceil((index + 1) / 8),
            }));

          resolve(sortedPlayers);
        } catch (error) {
          reject(error);
        }
      },
      error: (error) => {
        reject(error);
      },
    });
  });
};

export const exportToCSV = (teams: Team[]): string => {
  const rows: string[][] = [['Team', 'Player', 'Total Score', 'Draft Round', 'Draft Pick']];

  teams.forEach((team) => {
    // Use teamName if available, otherwise fall back to headCoach
    const displayName = team.teamName || team.headCoach || `Team ${team.draftPosition}`;
    team.roster.forEach((player: Player) => {
      rows.push([
        displayName,
        player.name,
        player.totalScore.toString(),
        player.draftedInRound?.toString() || '',
        player.draftedAtPick?.toString() || '',
      ]);
    });
    // Add team total row
    rows.push([displayName, 'TEAM TOTAL', team.totalScore.toString(), '', '']);
    rows.push([]); // Empty row between teams
  });

  return Papa.unparse(rows.map(row => row.map(neutralizeFormula)));
};
