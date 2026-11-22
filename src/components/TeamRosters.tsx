import { Team } from '../types';
import { useViewMode } from '../contexts/ViewContext';
import { getTeamDisplayName } from '../utils/teamUtils';

interface TeamRostersProps {
  teams: Team[];
  currentTeamId: string | null;
  currentRoundOrder?: string[];
  enforceAgeLimit?: boolean;
  maxPerAge?: number;
  showScores?: boolean;
}

export const TeamRosters = ({
  teams, currentTeamId, currentRoundOrder, enforceAgeLimit = false, maxPerAge = 0, showScores = true,
}: TeamRostersProps) => {
  const viewMode = useViewMode();
  const scoresVisible = viewMode !== 'public' && showScores;

  // Sort teams by current round draft order if provided
  const sortedTeams = currentRoundOrder && currentRoundOrder.length > 0
    ? [...teams].sort((a, b) => {
        const aIndex = currentRoundOrder.indexOf(a.id);
        const bIndex = currentRoundOrder.indexOf(b.id);
        // Teams not in order go to the end
        if (aIndex === -1) return 1;
        if (bIndex === -1) return -1;
        return aIndex - bIndex;
      })
    : teams;

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
      {sortedTeams.map((team, index) => (
        <div
          key={team.id}
          className={`
            relative rounded-lg p-4 border-2 transition-all
            ${
              team.id === currentTeamId
                ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                : 'border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800'
            }
          `}
        >
          {/* Picking indicator - top left corner */}
          {team.id === currentTeamId && (
            <span className="absolute -top-2 -left-2 text-[10px] bg-blue-500 text-white px-1.5 py-0.5 rounded font-medium shadow-sm">
              On The Clock
            </span>
          )}
          <div className="flex items-center gap-2 mb-3">
            {/* Pick order badge */}
            {currentRoundOrder && currentRoundOrder.length > 0 && (
              <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold flex-shrink-0 ${
                team.id === currentTeamId
                  ? 'bg-blue-500 text-white'
                  : 'bg-gray-300 dark:bg-gray-600 text-gray-700 dark:text-gray-300'
              }`}>
                {index + 1}
              </span>
            )}
            <h3 className="font-semibold text-lg text-gray-900 dark:text-white truncate">
              {getTeamDisplayName(team)}
            </h3>
          </div>

          {scoresVisible && (
            <div className="mb-3">
              <div className="text-2xl font-bold text-gray-900 dark:text-white">
                {team.totalScore.toFixed(1)} pts
              </div>
              <div className="text-xs text-gray-500 dark:text-gray-400">
                Avg: {team.roster.length > 0 ? (team.totalScore / team.roster.length).toFixed(1) : '0.0'} pts | {team.roster.length} players
              </div>
            </div>
          )}

          {/* Age Breakdown - only show if age limit is enforced */}
          {enforceAgeLimit && maxPerAge > 0 && Object.keys(team.ageBreakdown || {}).length > 0 && (
            <div className="mb-3">
              <div className="text-xs text-gray-600 dark:text-gray-400 mb-1">Ages</div>
              <div className="flex gap-1 flex-wrap">
                {Object.entries(team.ageBreakdown || {})
                  .sort(([a], [b]) => Number(a) - Number(b))
                  .map(([age, count]) => {
                    const isWarning = count === maxPerAge - 1;
                    const isMaxed = count >= maxPerAge;
                    return (
                      <span
                        key={age}
                        className={`text-xs px-1.5 py-0.5 rounded font-medium ${
                          isMaxed
                            ? 'bg-red-100 dark:bg-red-900 text-red-800 dark:text-red-200'
                            : isWarning
                            ? 'bg-yellow-100 dark:bg-yellow-900 text-yellow-800 dark:text-yellow-200'
                            : 'bg-gray-100 dark:bg-gray-700 text-gray-700 dark:text-gray-300'
                        }`}
                      >
                        {age}({count}){isMaxed ? '🚫' : isWarning ? '⚠️' : ''}
                      </span>
                    );
                  })}
              </div>
            </div>
          )}

          <div className="space-y-1">
            <div className="text-xs text-gray-600 dark:text-gray-400 mb-2">
              Roster ({team.roster.length})
            </div>
            {team.roster.length === 0 ? (
              <div className="text-sm text-gray-500 dark:text-gray-500 italic">
                No players yet
              </div>
            ) : (
              <div className="space-y-1 max-h-48 overflow-y-auto">
                {team.roster.map((player) => (
                  <div
                    key={player.id}
                    className="text-sm p-2 bg-gray-50 dark:bg-gray-700 rounded flex justify-between items-center"
                  >
                    <span className="text-gray-900 dark:text-white truncate">
                      {player.name}
                      {player.isCoachKid && (
                        <span className="ml-1 text-xs text-blue-600 dark:text-blue-400">★</span>
                      )}
                    </span>
                    {scoresVisible && (
                      <span className="text-gray-600 dark:text-gray-400 text-xs ml-2">
                        {player.totalScore.toFixed(1)}
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      ))}
    </div>
  );
};
