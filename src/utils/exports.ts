import { Team, Player, DraftPick, Division, Trade } from '../types';
import { getTeamDisplayName } from './teamUtils';

/**
 * Escape HTML entities to prevent XSS attacks.
 * Used when inserting user-generated content into HTML documents.
 */
function escapeHtml(text: string): string {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

const FORMULA_TRIGGER = /^[\s"]*[=+\-@]|^[\t\r]/;
const PLAIN_NUMBER = /^[+-]?\d+(\.\d+)?$/;

/**
 * Prefix a single quote to values a spreadsheet would run as a formula
 * (leading =, +, -, @, tab, or CR). Plain numbers such as "-1.5" are left as-is.
 */
export function neutralizeFormula(value: string): string {
  if (FORMULA_TRIGGER.test(value) && !PLAIN_NUMBER.test(value)) {
    return `'${value}`;
  }
  return value;
}

/**
 * Escape a single CSV cell: neutralize formulas, then quote if needed.
 */
export function escapeCSV(value: string): string {
  const safe = neutralizeFormula(value);
  if (/[",\r\n]/.test(safe)) {
    return `"${safe.replace(/"/g, '""')}"`;
  }
  return safe;
}

/**
 * Build one CSV line from raw cell values.
 */
export function toCSVRow(values: string[]): string {
  return values.map(escapeCSV).join(',');
}

/**
 * Neutralize user text embedded in plain-text reports that are downloaded as .csv.
 * Commas and line breaks inside the value start new cells, so each piece is checked.
 */
function safeText(value: string): string {
  return value
    .split(/([,\r\n])/)
    .map(part => (/^[,\r\n]$/.test(part) ? part : neutralizeFormula(part)))
    .join('');
}

/**
 * Generate public rosters for distribution to families.
 * NO scores, NO draft order, NO rankings - just alphabetical player lists.
 */
export function generatePublicRosters(teams: Team[], _players: Player[]): string {
  const output = teams
    .sort((a, b) => getTeamDisplayName(a).localeCompare(getTeamDisplayName(b)))
    .map(team => {
      const teamName = safeText(getTeamDisplayName(team));
      const headerLine = '═'.repeat(45);
      const dividerLine = '─'.repeat(45);

      // Get roster sorted alphabetically by last name
      const roster = team.roster
        .sort((a, b) => a.lastName.localeCompare(b.lastName))
        .map(p => {
          const bibStr = p.bib ? ` (#${safeText(p.bib)})` : '';
          return `  ${safeText(p.lastName)}, ${safeText(p.firstName)}${bibStr}`;
        })
        .join('\n');

      // Get manager name (headCoach is the primary field for manager's name)
      const managerName = team.headCoach ? `Coach ${safeText(team.headCoach)}` : 'TBD';

      // Get assistant coach
      const assistantCoach = team.assistantCoach ? `Coach ${safeText(team.assistantCoach)}` : 'None';

      return `
${headerLine}
         ${teamName.toUpperCase()}
${headerLine}

Manager: ${managerName}
Assistant Coach: ${assistantCoach}

ROSTER:
${dividerLine}
${roster || '  (No players)'}
${dividerLine}
`;
    })
    .join('\n');

  return output.trim();
}

/**
 * Generate official draft record for league archives.
 * Includes all picks by round, flags, and trade log.
 */
export function generateOfficialRecord(
  division: Division | null,
  teams: Team[],
  players: Player[],
  picks: DraftPick[],
  trades: Trade[] = []
): string {
  const divisionName = safeText(division?.name || 'Draft');
  const date = new Date().toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  });

  const headerLine = '═'.repeat(65);
  const sectionLine = '─'.repeat(65);

  // Group picks by round
  const picksByRound: Record<number, DraftPick[]> = {};
  picks.forEach(pick => {
    if (!picksByRound[pick.round]) {
      picksByRound[pick.round] = [];
    }
    picksByRound[pick.round].push(pick);
  });

  let output = `
${headerLine}
          ${divisionName.toUpperCase()} - OFFICIAL DRAFT RECORD
                    ${date}
${headerLine}
`;

  // Add picks by round
  Object.entries(picksByRound)
    .sort(([a], [b]) => Number(a) - Number(b))
    .forEach(([round, roundPicks]) => {
      output += `\nROUND ${round}\n`;
      output += `${sectionLine}\n`;

      roundPicks.forEach(pick => {
        const team = teams.find(t => t.id === pick.teamId);
        if (!team) return;

        const teamName = safeText(getTeamDisplayName(team)).padEnd(18);

        // Handle skipped picks
        if (pick.wasSkipped) {
          output += `Pick ${pick.pick.toString().padStart(2)}:  ${teamName} →  SKIPPED ⏭️\n`;
          return;
        }

        const player = players.find(p => p.id === pick.playerId);
        if (!player) return;

        // Build flags string
        const flags: string[] = [];
        if (player.isAllStar) flags.push('⭐');
        if (player.isCoachKid) flags.push('🔵');
        if (player.siblingId) flags.push('👥');
        const flagStr = flags.length > 0 ? ' ' + flags.join('') : '';

        const playerName = `${safeText(player.firstName)} ${safeText(player.lastName)}`;
        const bibNum = player.bib ? `(#${safeText(player.bib)})` : '';

        output += `Pick ${pick.pick.toString().padStart(2)}:  ${teamName} →  ${playerName} ${bibNum}${flagStr}\n`;
      });
    });

  // Add legend
  output += `
${headerLine}

LEGEND:
  ⭐ = All-Star
  🔵 = Coach's Kid
  👥 = Sibling
`;

  // Add trades if any
  if (trades.length > 0) {
    output += `
${sectionLine}
TRADES:
${sectionLine}
`;
    trades.forEach((trade, i) => {
      const player1 = players.find(p => p.id === trade.player1Id);
      const player2 = players.find(p => p.id === trade.player2Id);
      const team1 = teams.find(t => t.id === trade.team1Id);
      const team2 = teams.find(t => t.id === trade.team2Id);

      if (!player1 || !player2 || !team1 || !team2) return;

      const tradeDate = new Date(trade.timestamp).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric'
      });

      output += `Trade ${i + 1}: ${safeText(player1.firstName)} ${safeText(player1.lastName)} (${safeText(getTeamDisplayName(team1))}) ↔ ${safeText(player2.firstName)} ${safeText(player2.lastName)} (${safeText(getTeamDisplayName(team2))})\n`;
      output += `         Reason: ${safeText(trade.reason)}\n`;
      output += `         Approved: ${tradeDate}\n\n`;
    });
  }

  output += `${headerLine}\n`;

  return output.trim();
}

/**
 * Generate simulation draft board with two sections:
 * 1. Grid view (Rounds x Teams) - quick visual of who each team got, with team totals
 * 2. Pick-by-pick - sequential draft order showing Round, Pick #, Team, Player, Score
 */
export function generateSimulationDraftBoard(
  teams: Team[],
  draftOrder: string[]
): string {
  // Get teams in draft order
  const orderedTeams = draftOrder.map(id => teams.find(t => t.id === id)).filter((t): t is Team => t !== undefined);

  // Find max rounds (all teams should have same roster size)
  const maxRounds = Math.max(...teams.map(t => t.roster.length));

  // === SECTION 1: GRID VIEW ===
  const gridHeader = ['Round', 'Picks', ...orderedTeams.map(t => getTeamDisplayName(t))];
  const gridRows: string[][] = [];

  for (let round = 1; round <= maxRounds; round++) {
    const pickStart = (round - 1) * teams.length + 1;
    const pickEnd = round * teams.length;

    const row = [
      round.toString(),
      `${pickStart}-${pickEnd}`,
      ...orderedTeams.map(team => {
        const player = team.roster.find(p => p.draftedInRound === round);
        return player ? `${player.firstName} ${player.lastName}` : '';
      })
    ];
    gridRows.push(row);
  }

  // Add team total scores row
  const totalRow = [
    'TOTAL',
    '',
    ...orderedTeams.map(team => team.totalScore.toFixed(1))
  ];
  gridRows.push(totalRow);

  // === SECTION 2: PICK BY PICK ===
  // Collect all drafted players and sort by pick number
  const allPicks: { round: number; pick: number; team: string; player: string; score: number }[] = [];

  teams.forEach(team => {
    team.roster.forEach(player => {
      if (player.draftedAtPick && player.draftedInRound) {
        allPicks.push({
          round: player.draftedInRound,
          pick: player.draftedAtPick,
          team: getTeamDisplayName(team),
          player: `${player.firstName} ${player.lastName}`,
          score: player.totalScore
        });
      }
    });
  });

  allPicks.sort((a, b) => a.pick - b.pick);

  const pickHeader = ['Round', 'Pick', 'Team', 'Player', 'Score'];
  const pickRows = allPicks.map(p => [
    p.round.toString(),
    p.pick.toString(),
    p.team,
    p.player,
    p.score.toFixed(1)
  ]);

  // Combine sections
  const output = [
    '=== DRAFT BOARD ===',
    [gridHeader, ...gridRows].map(toCSVRow).join('\n'),
    '',
    '=== PICK BY PICK ===',
    [pickHeader, ...pickRows].map(toCSVRow).join('\n')
  ].join('\n');

  return output;
}

/**
 * Download text content as a file
 */
export function downloadTextFile(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Download CSV content as a file
 */
export function downloadCSV(content: string, filename: string): void {
  const blob = new Blob([content], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

/**
 * Open content in a new window for printing.
 * Content is escaped to prevent XSS attacks from user-generated data.
 */
export function openPrintWindow(content: string, title: string): void {
  const printWindow = window.open('', '_blank');
  if (!printWindow) {
    alert('Please allow popups to print');
    return;
  }

  // Escape both title and content to prevent XSS
  const safeTitle = escapeHtml(title);
  const safeContent = escapeHtml(content);

  printWindow.document.write(`
<!DOCTYPE html>
<html>
<head>
  <title>${safeTitle}</title>
  <style>
    body {
      font-family: 'Courier New', Courier, monospace;
      white-space: pre-wrap;
      padding: 20px;
      line-height: 1.4;
    }
    @media print {
      body { padding: 0; }
    }
  </style>
</head>
<body>${safeContent}</body>
</html>
  `);
  printWindow.document.close();
  printWindow.print();
}

/**
 * Copy content to clipboard
 */
export async function copyToClipboard(content: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(content);
    return true;
  } catch {
    // Fallback for older browsers
    const textArea = document.createElement('textarea');
    textArea.value = content;
    textArea.style.position = 'fixed';
    textArea.style.left = '-999999px';
    document.body.appendChild(textArea);
    textArea.select();
    try {
      document.execCommand('copy');
      document.body.removeChild(textArea);
      return true;
    } catch {
      document.body.removeChild(textArea);
      return false;
    }
  }
}

/**
 * Export players to CSV format that preserves coach kid and sibling mappings.
 * This export can be re-imported with mappings pre-populated for user confirmation.
 *
 * Columns:
 * - BIB, First Name, Last Name, Age, Total Score, Proj. Round
 * - Coach Kid (TRUE/FALSE), Coach Team (team name for coach kid assignment)
 * - Sibling (sibling's full name)
 * - All-Star (TRUE/FALSE), DNE (TRUE/FALSE)
 */
export function exportPlayersForReimport(players: Player[], teams: Team[]): string {
  const headers = [
    'BIB',
    'First Name',
    'Last Name',
    'Little League Age',
    'Total Score',
    'Fielding Subtotal',
    'Hitting Subtotal',
    'Pitching Subtotal',
    'Catch Score',
    'Running Score',
    'Official Adjust',
    'Coach Kid',
    'Coach Team',
    'Sibling',
    'All-Star',
    'DNE',
  ];

  const rows = players.map(player => {
    // Find the team name if this player is a coach kid
    let coachTeamName = '';
    if (player.isCoachKid && player.coachTeamId) {
      const team = teams.find(t => t.id === player.coachTeamId);
      coachTeamName = team ? (team.headCoach || team.teamName || '') : '';
    }

    // Find sibling name
    let siblingName = '';
    if (player.siblingId) {
      const sibling = players.find(p => p.id === player.siblingId);
      siblingName = sibling ? sibling.name : (player.sibling || '');
    } else if (player.sibling) {
      siblingName = player.sibling;
    }

    return [
      player.bib,
      player.firstName,
      player.lastName,
      player.littleLeagueAge.toString(),
      player.totalScore.toFixed(1),
      player.fieldingSubtotal.toFixed(1),
      player.hittingSubtotal.toFixed(1),
      player.pitchingSubtotal.toFixed(1),
      player.catchScore.toFixed(1),
      player.runningScore.toFixed(1),
      player.officialAdjust.toFixed(1),
      player.isCoachKid ? 'TRUE' : 'FALSE',
      coachTeamName,
      siblingName,
      player.isAllStar ? 'TRUE' : 'FALSE',
      player.isDNE ? 'TRUE' : 'FALSE',
    ];
  });

  const csvContent = [
    toCSVRow(headers),
    ...rows.map(toCSVRow)
  ].join('\n');

  return csvContent;
}

/**
 * Types for Team Builder happiness report
 */
export interface HappinessReportPlayer {
  playerId: string;
  playerName: string;
  teamName: string;
  totalScore: number;
  school?: string;
  grade?: number;
  happinessScore: 'all' | 'some' | 'none' | 'no-requests';
  coachRequest?: string;
  coachRequestStatus: 'honored' | 'not-honored' | 'not-participating' | 'none';
  teammateRequests: Array<{
    requestedName: string;
    isTwoWay: boolean;
    honored: boolean;
  }>;
}

/**
 * Generate happiness report CSV for Team Builder.
 * Includes per-player request fulfillment details.
 */
export function generateHappinessReportCSV(players: HappinessReportPlayer[]): string {
  // Find max teammate requests for column count
  const maxTeammateRequests = Math.max(
    ...players.map(p => p.teammateRequests.length),
    0
  );

  // Build headers
  const headers = [
    'Player Name',
    'Team',
    'Total Score',
    'School',
    'Grade',
    'Happiness',
    'Coach Request',
    'Coach Status',
  ];

  // Add teammate request columns
  for (let i = 1; i <= maxTeammateRequests; i++) {
    headers.push(`Teammate ${i}`);
    headers.push(`Type ${i}`);
    headers.push(`Status ${i}`);
  }

  // Build rows
  const rows = players.map(player => {
    const row = [
      player.playerName,
      player.teamName,
      player.totalScore.toFixed(1),
      player.school || '',
      player.grade?.toString() || '',
      getHappinessDisplayValue(player.happinessScore),
      player.coachRequest || '',
      getCoachStatusDisplayValue(player.coachRequestStatus),
    ];

    // Add teammate columns
    for (let i = 0; i < maxTeammateRequests; i++) {
      const req = player.teammateRequests[i];
      if (req) {
        row.push(req.requestedName);
        row.push(req.isTwoWay ? '2-way' : '1-way');
        row.push(req.honored ? 'Honored' : 'Not Honored');
      } else {
        row.push('', '', '');
      }
    }

    return row;
  });

  const csvContent = [
    toCSVRow(headers),
    ...rows.map(toCSVRow)
  ].join('\n');

  return csvContent;
}

function getHappinessDisplayValue(score: 'all' | 'some' | 'none' | 'no-requests'): string {
  switch (score) {
    case 'all': return 'All Honored';
    case 'some': return 'Partial';
    case 'none': return 'None Honored';
    case 'no-requests': return 'No Requests';
  }
}

function getCoachStatusDisplayValue(status: 'honored' | 'not-honored' | 'not-participating' | 'none'): string {
  switch (status) {
    case 'honored': return 'Honored';
    case 'not-honored': return 'Not Honored';
    case 'not-participating': return 'Coach Not Participating';
    case 'none': return '';
  }
}
