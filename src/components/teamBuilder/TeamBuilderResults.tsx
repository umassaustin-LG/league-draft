import { useState, useMemo } from 'react';
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  Users,
  BarChart3,
  Heart,
  RefreshCw,
  Download,
  Search,
} from 'lucide-react';
import {
  TeamBuilderResult,
  PlayerHappiness,
  HappinessScore,
  AssignmentResult,
  TeamBuilderPlayer,
} from '../../utils/teamBuilderAlgorithm';
import { Player } from '../../types';
import { generateHappinessReportCSV, downloadCSV, HappinessReportPlayer } from '../../utils/exports';

interface TeamBuilderResultsProps {
  result: TeamBuilderResult;
  players: Player[];
  onRerun?: () => void;
  onSwap?: (player1Id: string, player2Id: string) => void;
}

/**
 * Display Team Builder results with team summaries, player assignments,
 * and happiness indicators.
 */
export const TeamBuilderResults = ({
  result,
  players,
  onRerun,
}: TeamBuilderResultsProps) => {
  const [expandedTeamId, setExpandedTeamId] = useState<string | null>(null);
  const [view, setView] = useState<'teams' | 'players' | 'stats'>('teams');
  const [playerSearch, setPlayerSearch] = useState('');

  const playerMap = new Map(players.map(p => [p.id, p]));

  const toggleTeam = (teamId: string) => {
    setExpandedTeamId(expandedTeamId === teamId ? null : teamId);
  };

  const getHappinessEmoji = (score: HappinessScore): string => {
    switch (score) {
      case 'all': return '🟢';
      case 'some': return '🟡';
      case 'none': return '🔴';
      case 'no-requests': return '⚪';
    }
  };

  const getHappinessLabel = (score: HappinessScore): string => {
    switch (score) {
      case 'all': return 'All requests honored';
      case 'some': return 'Some requests honored';
      case 'none': return 'No requests honored';
      case 'no-requests': return 'No requests made';
    }
  };

  const getReasonLabel = (reason: AssignmentResult['reason']): string => {
    switch (reason) {
      case 'coach-kid': return 'Coach Kid';
      case 'assistant-coach-kid': return 'Asst. Coach Kid';
      case 'sibling-lock': return 'Sibling';
      case 'manual-lock': return 'Locked';
      case 'top-talent': return 'Top Talent';
      case 'two-way-friend': return 'Two-Way Friend';
      case 'one-way-friend': return 'One-Way Friend';
      case 'coach-request': return 'Coach Request';
      case 'school-cluster': return 'School';
      case 'balance': return 'Balance';
    }
  };

  const getTeamPlayers = (teamId: string): Array<{
    player: Player;
    assignment: AssignmentResult;
    happiness: PlayerHappiness;
  }> => {
    return result.assignments
      .filter(a => a.teamId === teamId)
      .map(assignment => {
        const player = playerMap.get(assignment.playerId)!;
        const happiness = result.playerHappiness.find(h => h.playerId === assignment.playerId)!;
        return { player, assignment, happiness };
      })
      .sort((a, b) => a.assignment.round - b.assignment.round || a.assignment.pick - b.assignment.pick);
  };

  // Build happiness report data for export
  const happinessReportData = useMemo((): HappinessReportPlayer[] => {
    return result.playerHappiness.map(happiness => {
      const player = playerMap.get(happiness.playerId);
      const assignment = result.assignments.find(a => a.playerId === happiness.playerId);
      const team = result.teamSummaries.find(t => t.teamId === assignment?.teamId);

      // Get the TeamBuilderPlayer to access request info
      const tbPlayer = players.find(p => p.id === happiness.playerId) as TeamBuilderPlayer | undefined;

      // Determine coach request status
      let coachRequestStatus: HappinessReportPlayer['coachRequestStatus'] = 'none';
      if (happiness.coachRequestHonored === true) {
        coachRequestStatus = 'honored';
      } else if (happiness.coachRequestHonored === false) {
        coachRequestStatus = 'not-honored';
      }

      // Build teammate request info
      const teammateRequests: HappinessReportPlayer['teammateRequests'] = [];
      if (tbPlayer?.teammateRequests) {
        const twoWaySet = new Set(tbPlayer.twoWayTeammateIds || []);
        const resolvedIds = tbPlayer.resolvedTeammateIds || [];

        tbPlayer.teammateRequests.forEach((reqName, idx) => {
          const resolvedId = resolvedIds[idx];
          const isTwoWay = resolvedId ? twoWaySet.has(resolvedId) : false;

          // Check if this teammate is on the same team
          const teammateAssignment = resolvedId
            ? result.assignments.find(a => a.playerId === resolvedId)
            : null;
          const honored = teammateAssignment?.teamId === assignment?.teamId;

          teammateRequests.push({
            requestedName: reqName,
            isTwoWay,
            honored,
          });
        });
      }

      return {
        playerId: happiness.playerId,
        playerName: player?.name || `Player ${happiness.playerId}`,
        teamName: team?.teamName || team?.coachName || '',
        totalScore: player?.totalScore || 0,
        school: tbPlayer?.school,
        grade: tbPlayer?.grade,
        happinessScore: happiness.score,
        coachRequest: tbPlayer?.coachRequest,
        coachRequestStatus,
        teammateRequests,
      };
    });
  }, [result, players, playerMap]);

  const handleExportHappiness = () => {
    const csv = generateHappinessReportCSV(happinessReportData);
    const date = new Date().toISOString().split('T')[0];
    downloadCSV(csv, `happiness-report-${date}.csv`);
  };

  return (
    <div className="space-y-6">
      {/* Header with stats */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-bold text-gray-900 dark:text-white">
            Team Builder Results
          </h2>
          <div className="flex items-center gap-2">
            <button
              onClick={handleExportHappiness}
              className="flex items-center gap-2 px-3 py-1.5 text-sm border border-green-500 text-green-600 dark:text-green-400 rounded-lg hover:bg-green-50 dark:hover:bg-green-900/20"
            >
              <Download className="w-4 h-4" />
              Export Report
            </button>
            {onRerun && (
              <button
                onClick={onRerun}
                className="flex items-center gap-2 px-3 py-1.5 text-sm border border-gray-300 dark:border-gray-600 rounded-lg hover:bg-gray-50 dark:hover:bg-gray-700"
              >
                <RefreshCw className="w-4 h-4" />
                Re-run
              </button>
            )}
          </div>
        </div>

        {/* Quick stats */}
        <div className="grid grid-cols-4 gap-4">
          <div className="text-center">
            <div className="text-2xl font-bold text-gray-900 dark:text-white">
              {result.stats.totalPlayers}
            </div>
            <div className="text-sm text-gray-500 dark:text-gray-400">Players</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-green-600 dark:text-green-400">
              {result.stats.requestingPlayers === 0
                ? 'No requests'
                : result.stats.coachRequestsTotal + result.stats.oneWayRequestsTotal + result.stats.twoWayRequestsTotal === 0
                  ? 'No confirmed requests'
                  : `${Math.round(result.stats.averageHappiness * 100)}%`}
            </div>
            <div className="text-sm text-gray-500 dark:text-gray-400">Happiness</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
              {result.stats.twoWayRequestsHonored}/{result.stats.twoWayRequestsTotal}
            </div>
            <div className="text-sm text-gray-500 dark:text-gray-400">Two-Way</div>
          </div>
          <div className="text-center">
            <div className="text-2xl font-bold text-purple-600 dark:text-purple-400">
              {result.stats.coachRequestsHonored}/{result.stats.coachRequestsTotal}
            </div>
            <div className="text-sm text-gray-500 dark:text-gray-400">Coach Req</div>
          </div>
        </div>
      </div>

      {/* Warnings */}
      {result.warnings.length > 0 && (
        <div className="bg-amber-50 dark:bg-amber-900/20 border border-amber-200 dark:border-amber-800 rounded-lg p-4">
          <div className="flex items-center gap-2 mb-2">
            <AlertTriangle className="w-5 h-5 text-amber-600 dark:text-amber-400" />
            <h3 className="font-semibold text-amber-800 dark:text-amber-200">
              Warnings ({result.warnings.length})
            </h3>
          </div>
          <ul className="text-sm text-amber-700 dark:text-amber-300 space-y-1">
            {result.warnings.map((warning, i) => (
              <li key={i}>• {warning}</li>
            ))}
          </ul>
        </div>
      )}

      {/* View tabs */}
      <div className="flex gap-2 border-b border-gray-200 dark:border-gray-700">
        <button
          onClick={() => setView('teams')}
          className={`flex items-center gap-2 px-4 py-2 border-b-2 transition-colors ${
            view === 'teams'
              ? 'border-blue-600 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          <Users className="w-4 h-4" />
          Teams
        </button>
        <button
          onClick={() => setView('players')}
          className={`flex items-center gap-2 px-4 py-2 border-b-2 transition-colors ${
            view === 'players'
              ? 'border-blue-600 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          <Heart className="w-4 h-4" />
          Happiness
        </button>
        <button
          onClick={() => setView('stats')}
          className={`flex items-center gap-2 px-4 py-2 border-b-2 transition-colors ${
            view === 'stats'
              ? 'border-blue-600 text-blue-600 dark:text-blue-400'
              : 'border-transparent text-gray-500 hover:text-gray-700 dark:hover:text-gray-300'
          }`}
        >
          <BarChart3 className="w-4 h-4" />
          Statistics
        </button>
      </div>

      {/* Teams view */}
      {view === 'teams' && (
        <div className="space-y-3">
          {result.teamSummaries.map((team) => {
            const isExpanded = expandedTeamId === team.teamId;
            const teamPlayers = getTeamPlayers(team.teamId);
            const balanceClass = team.meanDeltaPercent >= 0
              ? 'text-green-600 dark:text-green-400'
              : 'text-red-600 dark:text-red-400';

            return (
              <div
                key={team.teamId}
                className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden"
              >
                <button
                  onClick={() => toggleTeam(team.teamId)}
                  className="w-full px-4 py-3 flex items-center justify-between text-left hover:bg-gray-50 dark:hover:bg-gray-700/50"
                >
                  <div className="flex items-center gap-4">
                    <div>
                      <span className="font-semibold text-gray-900 dark:text-white">
                        {team.teamName || team.coachName}
                      </span>
                      <span className="ml-2 text-sm text-gray-500 dark:text-gray-400">
                        ({team.rosterCount} players)
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <div className="text-sm font-medium text-gray-900 dark:text-white">
                        {team.averageScore.toFixed(1)} avg
                      </div>
                      <div className={`text-xs ${balanceClass}`}>
                        {team.meanDeltaPercent >= 0 ? '+' : ''}{team.meanDeltaPercent.toFixed(1)}%
                      </div>
                    </div>
                    {isExpanded ? (
                      <ChevronUp className="w-5 h-5 text-gray-400" />
                    ) : (
                      <ChevronDown className="w-5 h-5 text-gray-400" />
                    )}
                  </div>
                </button>

                {isExpanded && (
                  <div className="border-t border-gray-200 dark:border-gray-700">
                    <table className="w-full text-sm">
                      <thead className="bg-gray-50 dark:bg-gray-700/50">
                        <tr>
                          <th className="px-4 py-2 text-left text-gray-500 dark:text-gray-400 font-medium">
                            Pick
                          </th>
                          <th className="px-4 py-2 text-left text-gray-500 dark:text-gray-400 font-medium">
                            Player
                          </th>
                          <th className="px-4 py-2 text-left text-gray-500 dark:text-gray-400 font-medium">
                            Score
                          </th>
                          <th className="px-4 py-2 text-left text-gray-500 dark:text-gray-400 font-medium">
                            Reason
                          </th>
                          <th className="px-4 py-2 text-center text-gray-500 dark:text-gray-400 font-medium">
                            Happy
                          </th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
                        {teamPlayers.map(({ player, assignment, happiness }) => (
                          <tr key={player.id} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                            <td className="px-4 py-2 text-gray-600 dark:text-gray-400">
                              {assignment.round}.{assignment.pick}
                            </td>
                            <td className="px-4 py-2 text-gray-900 dark:text-white">
                              {player.name}
                              {player.isCoachKid && (
                                <span className="ml-1 text-xs text-blue-600 dark:text-blue-400">
                                  (CK)
                                </span>
                              )}
                            </td>
                            <td className="px-4 py-2 text-gray-600 dark:text-gray-400">
                              {player.totalScore.toFixed(1)}
                            </td>
                            <td className="px-4 py-2">
                              <span className="px-2 py-0.5 text-xs bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 rounded">
                                {getReasonLabel(assignment.reason)}
                              </span>
                            </td>
                            <td className="px-4 py-2 text-center" title={getHappinessLabel(happiness.score)}>
                              {getHappinessEmoji(happiness.score)}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {/* Players/Happiness view */}
      {view === 'players' && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 overflow-hidden">
          {/* Search input */}
          <div className="p-4 border-b border-gray-200 dark:border-gray-700">
            <div className="relative">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
              <input
                type="text"
                value={playerSearch}
                onChange={(e) => setPlayerSearch(e.target.value)}
                placeholder="Search by player name..."
                className="w-full pl-10 pr-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg bg-white dark:bg-gray-700 text-gray-900 dark:text-white placeholder-gray-400 text-sm"
              />
            </div>
          </div>
          <table className="w-full text-sm">
            <thead className="bg-gray-50 dark:bg-gray-700/50">
              <tr>
                <th className="px-4 py-3 text-left text-gray-500 dark:text-gray-400 font-medium">
                  Player
                </th>
                <th className="px-4 py-3 text-left text-gray-500 dark:text-gray-400 font-medium">
                  Team
                </th>
                <th className="px-4 py-3 text-center text-gray-500 dark:text-gray-400 font-medium">
                  Status
                </th>
                <th className="px-4 py-3 text-left text-gray-500 dark:text-gray-400 font-medium">
                  Coach Request
                </th>
                <th className="px-4 py-3 text-left text-gray-500 dark:text-gray-400 font-medium">
                  Teammate Request
                </th>
                <th className="px-4 py-3 text-center text-gray-500 dark:text-gray-400 font-medium">
                  School
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100 dark:divide-gray-700">
              {result.playerHappiness
                .map(happiness => {
                  const player = playerMap.get(happiness.playerId)!;
                  const assignment = result.assignments.find(a => a.playerId === happiness.playerId);
                  const team = result.teamSummaries.find(t => t.teamId === assignment?.teamId);

                  // Calculate school count - number of teammates from the same school
                  let schoolCount = 0;
                  if (player.school && assignment?.teamId) {
                    const teamPlayerIds = result.assignments
                      .filter(a => a.teamId === assignment.teamId && a.playerId !== player.id)
                      .map(a => a.playerId);
                    schoolCount = teamPlayerIds.filter(id => {
                      const teammate = playerMap.get(id);
                      return teammate?.school && teammate.school.toLowerCase() === player.school!.toLowerCase();
                    }).length;
                  }

                  return { happiness, player, assignment, team, schoolCount };
                })
                .filter(({ player }) => {
                  // Apply search filter
                  if (!playerSearch.trim()) return true;
                  const query = playerSearch.toLowerCase().trim();
                  return player.name?.toLowerCase().includes(query) ||
                         player.firstName?.toLowerCase().includes(query) ||
                         player.lastName?.toLowerCase().includes(query);
                })
                .sort((a, b) => {
                  // If searching, prioritize exact matches
                  if (playerSearch.trim()) {
                    const query = playerSearch.toLowerCase().trim();
                    const aExact = a.player.name?.toLowerCase().startsWith(query) ? 0 : 1;
                    const bExact = b.player.name?.toLowerCase().startsWith(query) ? 0 : 1;
                    if (aExact !== bExact) return aExact - bExact;
                  }
                  // Sort by happiness (worst first for review)
                  const order = { 'none': 0, 'some': 1, 'all': 2, 'no-requests': 3 };
                  return order[a.happiness.score] - order[b.happiness.score];
                })
                .map(({ happiness, player, team, schoolCount }) => {
                  // Determine coach request status text
                  let coachRequestText: string;
                  let coachRequestClass: string;
                  if (happiness.coachRequestHonored === null) {
                    coachRequestText = 'Not Requested';
                    coachRequestClass = 'text-gray-400';
                  } else if (happiness.coachRequestHonored) {
                    coachRequestText = 'Granted';
                    coachRequestClass = 'text-green-600 dark:text-green-400';
                  } else {
                    coachRequestText = 'Not Granted';
                    coachRequestClass = 'text-red-600 dark:text-red-400';
                  }

                  // Determine teammate request status text
                  let teammateRequestText: string;
                  let teammateRequestClass: string;
                  if (happiness.teammateRequestsTotal === 0) {
                    teammateRequestText = 'Not Requested';
                    teammateRequestClass = 'text-gray-400';
                  } else if (happiness.teammateRequestsHonored === happiness.teammateRequestsTotal) {
                    teammateRequestText = 'Fully Granted';
                    teammateRequestClass = 'text-green-600 dark:text-green-400';
                  } else if (happiness.teammateRequestsHonored > 0) {
                    teammateRequestText = 'Partially Granted';
                    teammateRequestClass = 'text-amber-600 dark:text-amber-400';
                  } else {
                    teammateRequestText = 'Not Granted';
                    teammateRequestClass = 'text-red-600 dark:text-red-400';
                  }

                  return (
                    <tr key={happiness.playerId} className="hover:bg-gray-50 dark:hover:bg-gray-700/30">
                      <td className="px-4 py-3 text-gray-900 dark:text-white">
                        {player.name}
                      </td>
                      <td className="px-4 py-3 text-gray-600 dark:text-gray-400">
                        {team?.teamName || team?.coachName || '-'}
                      </td>
                      <td className="px-4 py-3 text-center">
                        <span title={getHappinessLabel(happiness.score)}>
                          {getHappinessEmoji(happiness.score)}
                        </span>
                      </td>
                      <td className={`px-4 py-3 ${coachRequestClass}`}>
                        <div>{coachRequestText}</div>
                        {player.coachRequest && (
                          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                            Requested: "{player.coachRequest}"
                          </div>
                        )}
                      </td>
                      <td className={`px-4 py-3 ${teammateRequestClass}`}>
                        <div>
                          {teammateRequestText}
                          {happiness.teammateRequestsTotal > 0 && (
                            <span className="text-xs text-gray-500 dark:text-gray-400 ml-1">
                              ({happiness.teammateRequestsHonored}/{happiness.teammateRequestsTotal})
                            </span>
                          )}
                        </div>
                        {player.teammateRequests && player.teammateRequests.length > 0 && (
                          <div className="text-xs text-gray-500 dark:text-gray-400 mt-0.5">
                            Requested: {player.teammateRequests.join(', ')}
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 text-center text-gray-600 dark:text-gray-400">
                        {player.school ? (
                          <span title={`${schoolCount} teammate${schoolCount !== 1 ? 's' : ''} from ${player.school}`}>
                            {schoolCount}
                          </span>
                        ) : (
                          <span className="text-gray-400">-</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
            </tbody>
          </table>
        </div>
      )}

      {/* Statistics view */}
      {view === 'stats' && (
        <div className="grid grid-cols-2 gap-4">
          {/* Placement breakdown */}
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-4">
              Placement Breakdown
            </h3>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">Locked (coach/sibling)</span>
                <span className="font-medium text-gray-900 dark:text-white">
                  {result.stats.lockedPlayers}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">Top Talent</span>
                <span className="font-medium text-gray-900 dark:text-white">
                  {result.stats.topTalentPlayers}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">Request-Based</span>
                <span className="font-medium text-gray-900 dark:text-white">
                  {result.stats.requestBasedPlayers}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">Balance-Based</span>
                <span className="font-medium text-gray-900 dark:text-white">
                  {result.stats.balanceBasedPlayers}
                </span>
              </div>
            </div>
          </div>

          {/* Request fulfillment */}
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-4">
              Request Fulfillment
            </h3>
            <div className="space-y-3">
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">Two-Way Friends</span>
                <span className="font-medium text-green-600 dark:text-green-400">
                  {result.stats.twoWayRequestsHonored}/{result.stats.twoWayRequestsTotal}
                  {result.stats.twoWayRequestsTotal > 0 && (
                    <span className="text-xs ml-1">
                      ({Math.round(result.stats.twoWayRequestsHonored / result.stats.twoWayRequestsTotal * 100)}%)
                    </span>
                  )}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">One-Way Friends</span>
                <span className="font-medium text-blue-600 dark:text-blue-400">
                  {result.stats.oneWayRequestsHonored}/{result.stats.oneWayRequestsTotal}
                  {result.stats.oneWayRequestsTotal > 0 && (
                    <span className="text-xs ml-1">
                      ({Math.round(result.stats.oneWayRequestsHonored / result.stats.oneWayRequestsTotal * 100)}%)
                    </span>
                  )}
                </span>
              </div>
              <div className="flex justify-between">
                <span className="text-gray-600 dark:text-gray-400">Coach Requests</span>
                <span className="font-medium text-purple-600 dark:text-purple-400">
                  {result.stats.coachRequestsHonored}/{result.stats.coachRequestsTotal}
                  {result.stats.coachRequestsTotal > 0 && (
                    <span className="text-xs ml-1">
                      ({Math.round(result.stats.coachRequestsHonored / result.stats.coachRequestsTotal * 100)}%)
                    </span>
                  )}
                </span>
              </div>
            </div>
          </div>

          {/* Happiness distribution */}
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-4">
              Happiness Distribution
            </h3>
            <div className="space-y-3">
              {(['all', 'some', 'none', 'no-requests'] as HappinessScore[]).map(score => {
                const count = result.playerHappiness.filter(h => h.score === score).length;
                const percent = result.stats.totalPlayers > 0
                  ? Math.round(count / result.stats.totalPlayers * 100)
                  : 0;
                return (
                  <div key={score} className="flex items-center justify-between">
                    <span className="flex items-center gap-2 text-gray-600 dark:text-gray-400">
                      {getHappinessEmoji(score)} {getHappinessLabel(score)}
                    </span>
                    <span className="font-medium text-gray-900 dark:text-white">
                      {count} ({percent}%)
                    </span>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Team balance */}
          <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200 dark:border-gray-700 p-4">
            <h3 className="font-semibold text-gray-900 dark:text-white mb-4">
              Team Balance (Avg Score)
            </h3>
            <div className="space-y-2">
              {result.teamSummaries
                .sort((a, b) => b.averageScore - a.averageScore)
                .map(team => {
                  const isBalanced = Math.abs(team.meanDeltaPercent) <= 10;
                  return (
                    <div key={team.teamId} className="flex items-center justify-between">
                      <span className="text-gray-600 dark:text-gray-400 truncate max-w-[150px]">
                        {team.teamName || team.coachName} ({team.rosterCount})
                      </span>
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-gray-900 dark:text-white">
                          {team.averageScore.toFixed(1)}
                        </span>
                        <span className={`text-xs ${
                          isBalanced
                            ? 'text-green-600 dark:text-green-400'
                            : 'text-amber-600 dark:text-amber-400'
                        }`}>
                          ({team.meanDeltaPercent >= 0 ? '+' : ''}{team.meanDeltaPercent.toFixed(1)}%)
                        </span>
                      </div>
                    </div>
                  );
                })}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
