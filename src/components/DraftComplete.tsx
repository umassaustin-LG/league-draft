import { useState, useMemo } from 'react';
import { Download, FileText, Printer, Copy, Check, ArrowLeftRight } from 'lucide-react';
import { DraftState, Division, Team } from '../types';
import { exportToCSV } from '../utils/csvParser';
import {
  generatePublicRosters,
  generateOfficialRecord,
  downloadCSV,
  openPrintWindow,
  copyToClipboard,
} from '../utils/exports';
import { TradeModal } from './TradeModal';
import { CompleteRosters } from './CompleteRosters';
import { TeamNameAssignment } from './shared';
import { getTeamDisplayName } from '../utils/teamUtils';

type MetricsView = 'full' | 'top8';

interface DraftCompleteProps {
  draftState: DraftState;
  division?: Division | null;
  onReset: () => void;
  onExecuteTrade?: (
    team1Id: string,
    team2Id: string,
    player1Id: string,
    player2Id: string,
    reason: string
  ) => void;
  onUpdateTeam?: (teamId: string, updates: Partial<Team>) => void;
  onReturnToDraftBoard?: () => void;
}

export const DraftComplete = ({ draftState, division, onReset, onExecuteTrade, onUpdateTeam, onReturnToDraftBoard }: DraftCompleteProps) => {
  const undraftedPlayers = draftState.players.filter(player => !player.isDrafted);
  const [copiedRosters, setCopiedRosters] = useState(false);
  const [copiedRecord, setCopiedRecord] = useState(false);
  const [showTradeModal, setShowTradeModal] = useState(false);
  const [metricsView, setMetricsView] = useState<MetricsView>('top8');

  // Calculate team metrics
  const teamMetrics = useMemo(() => {
    const TOP_PICKS_COUNT = 8;

    const metrics = draftState.teams.map(team => {
      // Full roster score
      const fullScore = team.totalScore;

      // Top 8 picks score (sorted by draft pick order)
      const sortedRoster = [...team.roster].sort((a, b) => {
        const pickA = a.draftedAtPick ?? Infinity;
        const pickB = b.draftedAtPick ?? Infinity;
        return pickA - pickB;
      });
      const top8Players = sortedRoster.slice(0, TOP_PICKS_COUNT);
      const top8Score = top8Players.reduce((sum, p) => sum + p.totalScore, 0);

      return {
        team,
        fullScore,
        top8Score,
        playerCount: team.roster.length,
        top8Count: top8Players.length,
      };
    });

    // Calculate stats for full rosters
    const fullScores = metrics.map(m => m.fullScore);
    const fullHighest = Math.max(...fullScores);
    const fullLowest = Math.min(...fullScores);
    const fullSpread = fullHighest - fullLowest;
    const fullAverage = fullScores.reduce((a, b) => a + b, 0) / fullScores.length;

    // Calculate stats for top 8
    const top8Scores = metrics.map(m => m.top8Score);
    const top8Highest = Math.max(...top8Scores);
    const top8Lowest = Math.min(...top8Scores);
    const top8Spread = top8Highest - top8Lowest;
    const top8Average = top8Scores.reduce((a, b) => a + b, 0) / top8Scores.length;

    // Rank teams by selected view
    const rankedByFull = [...metrics].sort((a, b) => b.fullScore - a.fullScore);
    const rankedByTop8 = [...metrics].sort((a, b) => b.top8Score - a.top8Score);

    return {
      teams: metrics,
      full: { highest: fullHighest, lowest: fullLowest, spread: fullSpread, average: fullAverage },
      top8: { highest: top8Highest, lowest: top8Lowest, spread: top8Spread, average: top8Average },
      rankedByFull,
      rankedByTop8,
    };
  }, [draftState.teams]);

  const handleExport = () => {
    const csvContent = exportToCSV(draftState.teams);
    const timestamp = new Date().toISOString().split('T')[0];
    downloadCSV(csvContent, `draft-results-${timestamp}.csv`);
  };

  // Public Rosters Export
  const handleDownloadPublicRosters = () => {
    const content = generatePublicRosters(draftState.teams, draftState.players);
    const divisionName = division?.name?.replace(/\s+/g, '-') || 'rosters';
    const timestamp = new Date().toISOString().split('T')[0];
    downloadCSV(content, `${divisionName}-rosters-${timestamp}.csv`);
  };

  const handlePrintPublicRosters = () => {
    const content = generatePublicRosters(draftState.teams, draftState.players);
    const title = `${division?.name || 'Draft'} - Team Rosters`;
    openPrintWindow(content, title);
  };

  const handleCopyPublicRosters = async () => {
    const content = generatePublicRosters(draftState.teams, draftState.players);
    const success = await copyToClipboard(content);
    if (success) {
      setCopiedRosters(true);
      setTimeout(() => setCopiedRosters(false), 2000);
    }
  };

  // Official Record Export
  const handleDownloadOfficialRecord = () => {
    const content = generateOfficialRecord(
      division ?? null,
      draftState.teams,
      draftState.players,
      draftState.picks,
      draftState.trades
    );
    const divisionName = division?.name?.replace(/\s+/g, '-') || 'draft';
    const timestamp = new Date().toISOString().split('T')[0];
    downloadCSV(content, `${divisionName}-official-record-${timestamp}.csv`);
  };

  const handlePrintOfficialRecord = () => {
    const content = generateOfficialRecord(
      division ?? null,
      draftState.teams,
      draftState.players,
      draftState.picks,
      draftState.trades
    );
    const title = `${division?.name || 'Draft'} - Official Record`;
    openPrintWindow(content, title);
  };

  const handleCopyOfficialRecord = async () => {
    const content = generateOfficialRecord(
      division ?? null,
      draftState.teams,
      draftState.players,
      draftState.picks,
      draftState.trades
    );
    const success = await copyToClipboard(content);
    if (success) {
      setCopiedRecord(true);
      setTimeout(() => setCopiedRecord(false), 2000);
    }
  };

  return (
    <div className="min-h-screen bg-gray-50 dark:bg-gray-900 p-4">
      <div className="max-w-7xl mx-auto">
        {/* Header */}
        <div className="bg-gradient-to-r from-green-500 to-blue-500 rounded-lg p-6 sm:p-8 mb-6 text-white">
          <div className="text-center">
            <h1 className="text-3xl sm:text-4xl font-bold mb-2">Draft Complete!</h1>
            <p className="text-lg opacity-90">
              {draftState.players.length - undraftedPlayers.length}/{draftState.players.length} players have been drafted
            </p>
            {undraftedPlayers.length > 0 && (
              <div role="alert" className="mt-4 rounded-lg bg-white/10 p-4 text-left">
                <p className="font-semibold">Undrafted players ({undraftedPlayers.length})</p>
                <ul>{undraftedPlayers.map(player => <li key={player.id}>{player.name}</li>)}</ul>
              </div>
            )}
          </div>

          <div className="flex justify-center gap-3 mt-6 flex-wrap">
            <button
              onClick={handleExport}
              className="px-4 py-2 bg-white text-blue-600 hover:bg-gray-100 rounded-lg font-medium flex items-center gap-2"
            >
              <Download className="w-5 h-5" />
              Export to CSV
            </button>
            {onExecuteTrade && (
              <button
                onClick={() => setShowTradeModal(true)}
                className="px-4 py-2 bg-white text-purple-600 hover:bg-gray-100 rounded-lg font-medium flex items-center gap-2"
              >
                <ArrowLeftRight className="w-5 h-5" />
                Make Trade
              </button>
            )}
            {onReturnToDraftBoard && (
              <button
                onClick={onReturnToDraftBoard}
                className="px-4 py-2 bg-white text-gray-700 hover:bg-gray-100 rounded-lg font-medium"
                title="Return to Draft Board to draft remaining players"
              >
                Back to Draft Board
              </button>
            )}
            <button
              onClick={onReset}
              className="px-4 py-2 bg-white/20 hover:bg-white/30 text-white rounded-lg font-medium"
              title="Return to Draft Setup - this will delete all draft picks"
            >
              Return to Draft Setup
            </button>
          </div>
        </div>

        {/* Export Options */}
        <div className="grid md:grid-cols-2 gap-6 mb-6">
          {/* Public Rosters Export */}
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
            <div className="flex items-start gap-3 mb-4">
              <FileText className="w-6 h-6 text-green-600 dark:text-green-400 flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white text-left">
                  Public Rosters
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-400 text-left">
                  Alphabetical player lists for families (no scores)
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleDownloadPublicRosters}
                className="flex-1 px-3 py-2 bg-green-100 dark:bg-green-900/30 text-green-700 dark:text-green-400 hover:bg-green-200 dark:hover:bg-green-900/50 rounded-lg font-medium flex items-center justify-center gap-2"
              >
                <Download className="w-4 h-4" />
                Download
              </button>
              <button
                onClick={handlePrintPublicRosters}
                className="px-3 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg"
                title="Print"
              >
                <Printer className="w-4 h-4" />
              </button>
              <button
                onClick={handleCopyPublicRosters}
                className="px-3 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg"
                title="Copy to clipboard"
              >
                {copiedRosters ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>

          {/* Official Record Export */}
          <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
            <div className="flex items-start gap-3 mb-4">
              <FileText className="w-6 h-6 text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="text-lg font-semibold text-gray-900 dark:text-white text-left">
                  Official Draft Record
                </h3>
                <p className="text-sm text-gray-600 dark:text-gray-400 text-left">
                  Complete pick history with flags and trades
                </p>
              </div>
            </div>
            <div className="flex gap-2">
              <button
                onClick={handleDownloadOfficialRecord}
                className="flex-1 px-3 py-2 bg-blue-100 dark:bg-blue-900/30 text-blue-700 dark:text-blue-400 hover:bg-blue-200 dark:hover:bg-blue-900/50 rounded-lg font-medium flex items-center justify-center gap-2"
              >
                <Download className="w-4 h-4" />
                Download
              </button>
              <button
                onClick={handlePrintOfficialRecord}
                className="px-3 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg"
                title="Print"
              >
                <Printer className="w-4 h-4" />
              </button>
              <button
                onClick={handleCopyOfficialRecord}
                className="px-3 py-2 bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-gray-600 rounded-lg"
                title="Copy to clipboard"
              >
                {copiedRecord ? <Check className="w-4 h-4 text-green-600" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </div>

        {/* Team Name Assignment */}
        {onUpdateTeam && (
          <div className="mb-6">
            <TeamNameAssignment
              teams={draftState.teams}
              onUpdateTeam={onUpdateTeam}
              title="Assign Team Names"
              description="Now that the draft is complete, assign official team names (e.g., 'Guardians', 'Yankees'). Teams are currently identified by manager name."
              collapsible={true}
              defaultExpanded={false}
            />
          </div>
        )}

        {/* Team Balance Metrics */}
        <div className="bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700 mb-6">
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white">
              Team Balance
            </h2>
            {/* Toggle between Full and Top 8 */}
            <div className="flex bg-gray-100 dark:bg-gray-700 rounded-lg p-1">
              <button
                onClick={() => setMetricsView('top8')}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  metricsView === 'top8'
                    ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                }`}
              >
                Top 8 Picks
              </button>
              <button
                onClick={() => setMetricsView('full')}
                className={`px-3 py-1.5 text-sm font-medium rounded-md transition-colors ${
                  metricsView === 'full'
                    ? 'bg-white dark:bg-gray-600 text-gray-900 dark:text-white shadow-sm'
                    : 'text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-white'
                }`}
              >
                Full Roster
              </button>
            </div>
          </div>

          {/* Stats Summary */}
          <div className="grid grid-cols-4 gap-4 mb-6">
            <div className="bg-green-50 dark:bg-green-900/30 rounded-lg p-4 text-center border border-green-200 dark:border-green-800">
              <div className="text-2xl font-bold text-gray-900 dark:text-white">
                {metricsView === 'top8'
                  ? teamMetrics.top8.highest.toFixed(1)
                  : teamMetrics.full.highest.toFixed(1)}
              </div>
              <div className="text-sm text-gray-600 dark:text-gray-400">Highest</div>
            </div>
            <div className="bg-red-50 dark:bg-red-900/30 rounded-lg p-4 text-center border border-red-200 dark:border-red-800">
              <div className="text-2xl font-bold text-gray-900 dark:text-white">
                {metricsView === 'top8'
                  ? teamMetrics.top8.lowest.toFixed(1)
                  : teamMetrics.full.lowest.toFixed(1)}
              </div>
              <div className="text-sm text-gray-600 dark:text-gray-400">Lowest</div>
            </div>
            <div className="bg-blue-50 dark:bg-blue-900/30 rounded-lg p-4 text-center border border-blue-200 dark:border-blue-800">
              <div className="text-2xl font-bold text-blue-600 dark:text-blue-400">
                {metricsView === 'top8'
                  ? teamMetrics.top8.spread.toFixed(1)
                  : teamMetrics.full.spread.toFixed(1)}
              </div>
              <div className="text-sm text-gray-600 dark:text-gray-400">Spread</div>
            </div>
            <div className="bg-gray-50 dark:bg-gray-700 rounded-lg p-4 text-center border border-gray-200 dark:border-gray-600">
              <div className="text-2xl font-bold text-gray-900 dark:text-white">
                {metricsView === 'top8'
                  ? teamMetrics.top8.average.toFixed(1)
                  : teamMetrics.full.average.toFixed(1)}
              </div>
              <div className="text-sm text-gray-600 dark:text-gray-400">Average</div>
            </div>
          </div>

          {/* Team Rankings */}
          <div>
            <h3 className="text-sm font-medium text-gray-500 dark:text-gray-400 mb-3 uppercase tracking-wide">
              Team Rankings ({metricsView === 'top8' ? 'by Top 8 Picks' : 'by Full Roster'})
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
              {(metricsView === 'top8' ? teamMetrics.rankedByTop8 : teamMetrics.rankedByFull).map((m, index) => {
                const score = metricsView === 'top8' ? m.top8Score : m.fullScore;
                const highest = metricsView === 'top8' ? teamMetrics.top8.highest : teamMetrics.full.highest;
                const lowest = metricsView === 'top8' ? teamMetrics.top8.lowest : teamMetrics.full.lowest;
                const isHighest = score === highest;
                const isLowest = score === lowest;

                return (
                  <div
                    key={m.team.id}
                    className={`p-3 rounded-lg border ${
                      isHighest
                        ? 'bg-green-50 dark:bg-green-900/20 border-green-200 dark:border-green-800'
                        : isLowest
                        ? 'bg-red-50 dark:bg-red-900/20 border-red-200 dark:border-red-800'
                        : 'bg-gray-50 dark:bg-gray-700/50 border-gray-200 dark:border-gray-600'
                    }`}
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className={`text-lg font-bold ${
                          isHighest ? 'text-green-600 dark:text-green-400' :
                          isLowest ? 'text-red-600 dark:text-red-400' :
                          'text-gray-400 dark:text-gray-500'
                        }`}>
                          #{index + 1}
                        </span>
                        <span className="font-medium text-gray-900 dark:text-white truncate">
                          {getTeamDisplayName(m.team)}
                        </span>
                      </div>
                      <span className="font-bold text-gray-900 dark:text-white">
                        {score.toFixed(1)}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <p className="text-xs text-gray-500 dark:text-gray-400 mt-4">
            {metricsView === 'top8'
              ? 'Top 8 picks metric excludes late-round players to better reflect core team strength.'
              : 'Full roster includes all drafted players.'}
          </p>
        </div>

        {/* Full Rosters */}
        <CompleteRosters teams={draftState.teams} />

        {/* Trade History */}
        {draftState.trades.length > 0 && (
          <div className="mt-6 bg-white dark:bg-gray-800 rounded-lg p-6 border border-gray-200 dark:border-gray-700">
            <h2 className="text-xl font-semibold text-gray-900 dark:text-white mb-4 flex items-center gap-2">
              <ArrowLeftRight className="w-5 h-5 text-purple-600" />
              Trade History
            </h2>
            <div className="space-y-3">
              {draftState.trades.map((trade, index) => {
                const player1 = draftState.players.find(p => p.id === trade.player1Id);
                const player2 = draftState.players.find(p => p.id === trade.player2Id);
                const team1 = draftState.teams.find(t => t.id === trade.team1Id);
                const team2 = draftState.teams.find(t => t.id === trade.team2Id);
                const tradeDate = new Date(trade.timestamp).toLocaleDateString('en-US', {
                  month: 'short',
                  day: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit',
                });

                return (
                  <div
                    key={trade.id}
                    className="p-4 bg-gray-50 dark:bg-gray-700/50 rounded-lg"
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1">
                        <div className="font-medium text-gray-900 dark:text-white">
                          Trade {index + 1}
                        </div>
                        <div className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                          {player1?.firstName} {player1?.lastName} ({getTeamDisplayName(team1!)})
                          <span className="mx-2 text-purple-600">↔</span>
                          {player2?.firstName} {player2?.lastName} ({getTeamDisplayName(team2!)})
                        </div>
                        <div className="text-xs text-gray-500 dark:text-gray-400 mt-1">
                          Reason: {trade.reason}
                        </div>
                      </div>
                      <div className="text-xs text-gray-500 dark:text-gray-400">
                        {tradeDate}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      {/* Trade Modal */}
      {showTradeModal && onExecuteTrade && (
        <TradeModal
          teams={draftState.teams}
          players={draftState.players}
          onExecuteTrade={onExecuteTrade}
          onClose={() => setShowTradeModal(false)}
        />
      )}
    </div>
  );
};
