import { useMemo } from 'react';
import { Lock } from 'lucide-react';
import { Player, Team } from '../../types';
import { getTeamDisplayName } from '../../utils/teamUtils';

interface DraftBoardRosterViewProps {
  teams: Team[];
  players: Player[];
  draftOrder: string[];
  currentRound: number;
  currentPickInRound: number;
  currentRoundOrder: string[];
  showScores: boolean;
  totalRounds: number;
  isPublicView: boolean;
}

interface CellData {
  type: 'empty' | 'drafted' | 'prefilled';
  player?: Player;
  prefilledReason?: 'coach-kid' | 'sibling';
}

export const DraftBoardRosterView = ({
  teams,
  players,
  currentRound,
  currentPickInRound,
  currentRoundOrder,
  showScores,
  totalRounds,
  isPublicView,
}: DraftBoardRosterViewProps) => {
  // Get teams in current round order
  const sortedTeams = useMemo(() => {
    if (currentRoundOrder.length > 0) {
      return [...teams].sort((a, b) => {
        const aIndex = currentRoundOrder.indexOf(a.id);
        const bIndex = currentRoundOrder.indexOf(b.id);
        if (aIndex === -1) return 1;
        if (bIndex === -1) return -1;
        return aIndex - bIndex;
      });
    }
    return teams;
  }, [teams, currentRoundOrder]);

  // Get the player drafted in a specific round by a specific team
  const getDraftedPlayer = (teamId: string, round: number): Player | undefined => {
    return players.find(
      p => p.isDrafted && p.draftedByTeamId === teamId && p.draftedInRound === round
    );
  };

  // Get pre-filled player (coach's kid or sibling) for a team in a specific round
  const getPrefilledPlayer = (teamId: string, round: number): { player: Player; reason: 'coach-kid' | 'sibling' } | undefined => {
    const prefilled = players.find(p => {
      if (p.isDrafted) return false;
      const effectiveRound = p.lockedToRound ?? p.projectedRound;
      if (effectiveRound !== round) return false;

      if (p.isCoachKid && p.coachTeamId) {
        return p.coachTeamId === teamId;
      }

      if (p.lockedToTeamId === teamId) {
        return true;
      }

      return false;
    });

    if (!prefilled) return undefined;

    const reason: 'coach-kid' | 'sibling' =
      prefilled.isCoachKid && prefilled.coachTeamId === teamId ? 'coach-kid' : 'sibling';

    return { player: prefilled, reason };
  };

  // Build cell data for each round x team combination
  const getCellData = (teamId: string, round: number): CellData => {
    const draftedPlayer = getDraftedPlayer(teamId, round);
    if (draftedPlayer) {
      return { type: 'drafted', player: draftedPlayer };
    }

    const prefilled = getPrefilledPlayer(teamId, round);
    if (prefilled) {
      return {
        type: 'prefilled',
        player: prefilled.player,
        prefilledReason: prefilled.reason,
      };
    }

    return { type: 'empty' };
  };

  // Determine if a cell is the current pick
  const isCurrentPick = (teamId: string, round: number): boolean => {
    if (round !== currentRound) return false;
    const teamIndex = currentRoundOrder.indexOf(teamId);
    return teamIndex === currentPickInRound - 1;
  };

  // Determine if a round/pick has already happened
  const isPastPick = (teamId: string, round: number): boolean => {
    if (round < currentRound) return true;
    if (round === currentRound) {
      const teamIndex = currentRoundOrder.indexOf(teamId);
      return teamIndex < currentPickInRound - 1;
    }
    return false;
  };

  const rounds = useMemo(() => {
    return Array.from({ length: totalRounds }, (_, i) => i + 1);
  }, [totalRounds]);

  return (
    <div className="bg-surface border border-rule rounded-sharp overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-2 border-b border-rule">
              <th className="sticky left-0 z-20 bg-surface-2 px-3 py-2 text-left text-xs font-semibold uppercase tracking-label text-ink-muted w-16 border-r border-rule">
                Round
              </th>
              {sortedTeams.map((team, idx) => {
                const isCurrent = team.id === currentRoundOrder[currentPickInRound - 1];
                return (
                  <th
                    key={team.id}
                    className={`px-2 py-2 text-center text-xs font-semibold min-w-[140px] ${
                      isCurrent
                        ? 'bg-brand-soft text-ink'
                        : 'text-ink-muted'
                    }`}
                  >
                    <div className="flex flex-col items-center gap-0.5">
                      <span className="font-mono text-[10px] uppercase tracking-label text-ink-faint">
                        #{idx + 1}
                      </span>
                      <span className="truncate max-w-[130px]">
                        {getTeamDisplayName(team)}
                      </span>
                      {!isPublicView && showScores && (
                        <span className="font-mono text-[10px] font-normal tabular-nums text-ink-muted">
                          {team.totalScore.toFixed(1)} pts
                        </span>
                      )}
                    </div>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {rounds.map((round) => (
              <tr key={round}>
                <td className="sticky left-0 z-10 bg-surface px-3 py-2 text-center font-mono font-semibold tabular-nums text-ink border-r border-rule">
                  {round}
                </td>
                {sortedTeams.map((team) => {
                  const cellData = getCellData(team.id, round);
                  const isCurrent = isCurrentPick(team.id, round);
                  const isPast = isPastPick(team.id, round);

                  return (
                    <td
                      key={team.id}
                      className={`px-2 py-2 text-center transition-colors ${
                        isCurrent
                          ? 'bg-brand-soft ring-1 ring-inset ring-brand'
                          : isPast
                          ? 'bg-surface-2'
                          : ''
                      }`}
                    >
                      {cellData.type === 'drafted' && cellData.player && (
                        <div className="bg-surface-2 border border-rule rounded-sharp px-2 py-1">
                          <div className="font-medium text-ink text-xs truncate">
                            {cellData.player.name}
                          </div>
                          {!isPublicView && showScores && (
                            <div className="font-mono text-[10px] tabular-nums text-ink-muted">
                              {cellData.player.totalScore.toFixed(1)} pts
                            </div>
                          )}
                          {(cellData.player.isCoachKid || cellData.player.lockedToTeamId) && (
                            <span
                              className="inline-flex items-center gap-0.5 mt-0.5 px-1 py-0.5 text-[8px] font-semibold rounded-sharp border border-rule bg-surface text-ink-muted"
                              title="Locked to team"
                            >
                              <Lock className="w-2 h-2" />
                            </span>
                          )}
                        </div>
                      )}

                      {cellData.type === 'prefilled' && cellData.player && (
                        <div className="bg-brand-soft border border-dashed border-brand rounded-sharp px-2 py-1">
                          <div className="font-medium text-ink text-xs truncate">
                            {cellData.player.name}
                          </div>
                          {!isPublicView && showScores && (
                            <div className="font-mono text-[10px] tabular-nums text-ink-muted">
                              {cellData.player.totalScore.toFixed(1)} pts
                            </div>
                          )}
                          <span
                            className="inline-flex items-center gap-0.5 mt-0.5 px-1 py-0.5 text-[8px] font-semibold rounded-sharp border border-rule bg-surface text-ink-muted"
                            title={cellData.prefilledReason === 'coach-kid' ? "Coach's kid" : 'Sibling locked'}
                          >
                            <Lock className="w-2 h-2" />
                          </span>
                        </div>
                      )}

                      {cellData.type === 'empty' && (
                        <div className={`h-10 ${
                          isCurrent
                            ? 'border-2 border-dashed border-brand rounded-sharp flex items-center justify-center'
                            : ''
                        }`}>
                          {isCurrent && (
                            <span className="font-mono text-[10px] uppercase tracking-label font-semibold text-brand">
                              Picking
                            </span>
                          )}
                        </div>
                      )}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="px-4 py-2.5 border-t border-rule bg-surface-2">
        <div className="flex items-center gap-4 text-xs text-ink-muted">
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 bg-surface-2 border border-rule rounded-sharp"></div>
            <span>Drafted</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 bg-brand-soft border border-dashed border-brand rounded-sharp"></div>
            <span>Pre-filled (locked)</span>
          </div>
          <div className="flex items-center gap-1.5">
            <Lock className="w-3 h-3" />
            <span>Locked to team</span>
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-3 h-3 border-2 border-dashed border-brand rounded-sharp"></div>
            <span>Current pick</span>
          </div>
        </div>
      </div>
    </div>
  );
};
