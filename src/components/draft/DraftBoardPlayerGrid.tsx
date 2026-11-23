import { useState, useMemo, useRef, useEffect } from 'react';
import { Search, X, ChevronDown, ChevronUp, Lock, Users } from 'lucide-react';
import { Player, Team } from '../../types';
import { getTeamDisplayName } from '../../utils/teamUtils';

interface DraftBoardPlayerGridProps {
  players: Player[];
  currentTeamId: string | null;
  teams: Team[];
  showScores: boolean;
  onDraftPlayer?: (playerId: string) => void;
  mandatoryPick?: {
    playerId: string;
    reason: 'coach-kid' | 'sibling';
    siblingName?: string;
  } | null;
  isLoading: boolean;
  enforceAgeLimit: boolean;
  maxPerAge: number;
  currentTeamAgeBreakdown: Record<string, number>;
  isReadOnly: boolean;
  // When provided, renders the Best-by-Age quick-pick strip above the search.
  // Clicking a quick-pick defers to the scoreboard's pending-confirm flow in the parent.
  onQuickPick?: (player: Player) => void;
  // Called when a Draft click would push the team past the age limit.
  // Parent routes this through the scoreboard confirmation banner instead of a browser dialog.
  onAgeOverrideNeeded?: (player: Player, currentCount: number) => void;
}

type SortField = 'rank' | 'bib' | 'name' | 'age' | 'school' | 'allstar' | 'sibling' | 'team' | 'draftedRound' | 'round' | 'fielding' | 'hitting' | 'pitching' | 'catch' | 'running' | 'total';
type SortDirection = 'asc' | 'desc';

export const DraftBoardPlayerGrid = ({
  players,
  currentTeamId,
  teams,
  showScores,
  onDraftPlayer,
  mandatoryPick,
  isLoading,
  enforceAgeLimit,
  maxPerAge,
  currentTeamAgeBreakdown,
  isReadOnly,
  onQuickPick,
  onAgeOverrideNeeded,
}: DraftBoardPlayerGridProps) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [sortField, setSortField] = useState<SortField>('rank');
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc');
  const [showAllPlayers, setShowAllPlayers] = useState(false);
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Filter players based on showAllPlayers toggle
  const filteredPlayers = useMemo(() => {
    return players
      .filter((p) => showAllPlayers || !p.isDrafted)
      .filter((p) =>
        searchTerm === '' ||
        p.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
        p.bib.toLowerCase().includes(searchTerm.toLowerCase())
      );
  }, [players, searchTerm, showAllPlayers]);

  // Helper to get team name for a player
  const getPlayerTeamName = (player: Player): string | null => {
    // If drafted, show the team that drafted them
    if (player.isDrafted && player.draftedByTeamId) {
      const team = teams.find(t => t.id === player.draftedByTeamId);
      return team ? getTeamDisplayName(team) : null;
    }
    // If locked (coach's kid or sibling), show locked team
    if (player.isCoachKid && player.coachTeamId) {
      const team = teams.find(t => t.id === player.coachTeamId);
      return team ? getTeamDisplayName(team) : null;
    }
    if (player.lockedToTeamId) {
      const team = teams.find(t => t.id === player.lockedToTeamId);
      return team ? getTeamDisplayName(team) : null;
    }
    return null;
  };

  // Helper to get sibling BIB
  const getSiblingBib = (player: Player): string | null => {
    if (!player.siblingId) return null;
    const sibling = players.find(p => p.id === player.siblingId);
    return sibling ? sibling.bib : null;
  };

  // Sort players
  const sortedPlayers = useMemo(() => {
    return [...filteredPlayers].sort((a, b) => {
      let aVal: number | string = 0;
      let bVal: number | string = 0;

      switch (sortField) {
        case 'rank':
          aVal = a.rank;
          bVal = b.rank;
          break;
        case 'bib':
          aVal = parseInt(a.bib) || 0;
          bVal = parseInt(b.bib) || 0;
          break;
        case 'name':
          aVal = a.name;
          bVal = b.name;
          break;
        case 'age':
          aVal = a.littleLeagueAge;
          bVal = b.littleLeagueAge;
          break;
        case 'school':
          aVal = a.school || '';
          bVal = b.school || '';
          break;
        case 'allstar':
          aVal = a.isAllStar ? 1 : 0;
          bVal = b.isAllStar ? 1 : 0;
          break;
        case 'sibling':
          aVal = getSiblingBib(a) || 'zzz';
          bVal = getSiblingBib(b) || 'zzz';
          break;
        case 'team':
          aVal = getPlayerTeamName(a) || 'zzz';
          bVal = getPlayerTeamName(b) || 'zzz';
          break;
        case 'draftedRound':
          aVal = a.draftedInRound ?? 999;
          bVal = b.draftedInRound ?? 999;
          break;
        case 'round':
          aVal = a.lockedToRound ?? a.projectedRound;
          bVal = b.lockedToRound ?? b.projectedRound;
          break;
        case 'fielding':
          aVal = a.fieldingSubtotal;
          bVal = b.fieldingSubtotal;
          break;
        case 'hitting':
          aVal = a.hittingSubtotal;
          bVal = b.hittingSubtotal;
          break;
        case 'pitching':
          aVal = a.pitchingSubtotal;
          bVal = b.pitchingSubtotal;
          break;
        case 'catch':
          aVal = a.catchScore;
          bVal = b.catchScore;
          break;
        case 'running':
          aVal = a.runningScore;
          bVal = b.runningScore;
          break;
        case 'total':
          aVal = a.totalScore;
          bVal = b.totalScore;
          break;
      }

      if (typeof aVal === 'string' && typeof bVal === 'string') {
        return sortDirection === 'asc'
          ? aVal.localeCompare(bVal)
          : bVal.localeCompare(aVal);
      }

      return sortDirection === 'asc'
        ? (aVal as number) - (bVal as number)
        : (bVal as number) - (aVal as number);
    });
  }, [filteredPlayers, sortField, sortDirection, teams, players]);

  // Best-by-Age quick picks: top 2 eligible per age, by score.
  // Excludes drafted players and those locked to other teams (coach kids / siblings).
  const bestByAge = useMemo(() => {
    if (!onQuickPick) return [];
    const byAge: Record<number, Player[]> = {};
    players.forEach((player) => {
      if (player.isDrafted) return;
      const isCoachKidForOther = player.isCoachKid && player.coachTeamId && player.coachTeamId !== currentTeamId;
      const isSiblingLockedToOther = player.lockedToTeamId && player.lockedToTeamId !== currentTeamId;
      if (isCoachKidForOther || isSiblingLockedToOther) return;
      const age = player.littleLeagueAge;
      if (!byAge[age]) byAge[age] = [];
      byAge[age].push(player);
    });
    return Object.keys(byAge)
      .map(Number)
      .sort((a, b) => a - b)
      .map((age) => ({
        age,
        players: byAge[age].sort((a, b) => b.totalScore - a.totalScore).slice(0, 2),
      }))
      .filter((group) => group.players.length > 0);
  }, [players, currentTeamId, onQuickPick]);

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortField(field);
      // Default to descending for score fields, ascending for others
      const scoreFields: SortField[] = ['fielding', 'hitting', 'pitching', 'catch', 'running', 'total', 'allstar'];
      setSortDirection(scoreFields.includes(field) ? 'desc' : 'asc');
    }
  };

  const SortIndicator = ({ field }: { field: SortField }) => (
    sortField === field ? (
      sortDirection === 'asc' ? (
        <ChevronUp className="w-3 h-3 inline ml-0.5" />
      ) : (
        <ChevronDown className="w-3 h-3 inline ml-0.5" />
      )
    ) : null
  );

  const isPlayerRestricted = (player: Player) => {
    if (player.isDrafted) return true;

    const isCoachKidForOtherTeam = player.isCoachKid &&
      player.coachTeamId &&
      player.coachTeamId !== currentTeamId;

    const isSiblingLockedToOtherTeam = player.lockedToTeamId &&
      player.lockedToTeamId !== currentTeamId;

    return isCoachKidForOtherTeam || isSiblingLockedToOtherTeam;
  };

  const isPlayerAgeMaxed = (player: Player) => {
    if (!enforceAgeLimit || maxPerAge <= 0) return false;
    if (player.isDrafted) return false;
    const currentCount = currentTeamAgeBreakdown[player.littleLeagueAge] || 0;
    return currentCount >= maxPerAge;
  };

  const handleDraft = (player: Player) => {
    if (isPlayerAgeMaxed(player) && onAgeOverrideNeeded) {
      const currentCount = currentTeamAgeBreakdown[player.littleLeagueAge] || 0;
      onAgeOverrideNeeded(player, currentCount);
      return;
    }
    onDraftPlayer?.(player.id);
  };

  // Global keyboard shortcuts scoped to the drawer:
  // `/` focuses search, `Esc` clears it, `Enter` drafts the top eligible player
  // when nothing is typing. Skips when DraftBoard has already claimed the event.
  useEffect(() => {
    if (isReadOnly) return;

    const handler = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;

      const target = e.target as HTMLElement | null;
      const isTyping =
        !!target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.isContentEditable);

      if (e.key === '/' && !isTyping) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if (
        e.key === 'Escape' &&
        searchTerm &&
        document.activeElement === searchInputRef.current
      ) {
        e.preventDefault();
        setSearchTerm('');
        return;
      }

      if (e.key === 'Enter' && !isTyping && onQuickPick && !mandatoryPick) {
        const top = sortedPlayers.find((p) => !isPlayerRestricted(p));
        if (top) {
          e.preventDefault();
          if (isPlayerAgeMaxed(top) && onAgeOverrideNeeded) {
            onAgeOverrideNeeded(top, currentTeamAgeBreakdown[top.littleLeagueAge] || 0);
          } else {
            onQuickPick(top);
          }
        }
      }
    };

    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    isReadOnly,
    searchTerm,
    onQuickPick,
    onAgeOverrideNeeded,
    mandatoryPick,
    sortedPlayers,
    currentTeamId,
    enforceAgeLimit,
    maxPerAge,
    currentTeamAgeBreakdown,
  ]);

  // Calculate column count for empty state
  const getColumnCount = () => {
    let count = 11; // proj, rank, bib, allstar, name, age, school, team, flags, sibling, action
    if (showAllPlayers) count += 1; // drafted round column
    if (showScores) count += 6; // F, H, P, C, R, Total
    if (isReadOnly) count -= 1; // no action column
    return count;
  };

  const availableCount = players.filter(p => !p.isDrafted).length;

  // Shared <th> class for sortable columns — keeps the header voice consistent.
  const thSortable = 'px-2 py-2 text-xs font-semibold uppercase tracking-label text-ink-muted cursor-pointer hover:text-ink hover:bg-surface-3 transition-colors';

  return (
    <div className="bg-surface border border-rule rounded-sharp">
      {/* Best-by-Age quick-pick strip (only when scoreboard is in on-deck mode) */}
      {bestByAge.length > 0 && (
        <div className="px-4 py-3 border-b border-rule bg-surface-2">
          <div className="flex items-center gap-4 overflow-x-auto">
            <div className="flex flex-col flex-shrink-0 pr-2">
              <span className="font-mono text-[10px] uppercase tracking-label text-ink-faint">Quick pick</span>
              <span className="font-mono text-[10px] uppercase tracking-label text-ink-muted">Best by age</span>
            </div>
            {bestByAge.map(({ age, players: ageGroup }, groupIdx) => (
              <div
                key={age}
                className={`flex items-center gap-1.5 flex-shrink-0 ${
                  groupIdx === 0 ? '' : 'border-l border-rule pl-4'
                }`}
              >
                <span className="font-mono text-[11px] tabular-nums text-ink-faint w-5 text-right">
                  {age}
                </span>
                {ageGroup.map((player) => (
                  <button
                    key={player.id}
                    onClick={() => onQuickPick?.(player)}
                    disabled={isLoading}
                    className="group flex items-center gap-2 px-2 py-1 rounded-sharp border border-rule hover:border-brand hover:bg-brand-soft text-xs font-medium text-ink disabled:opacity-50 transition-colors"
                    title={`Draft ${player.firstName} ${player.lastName} (${player.totalScore.toFixed(1)} pts)`}
                  >
                    <span>{player.firstName} {player.lastName.charAt(0)}.</span>
                    <span className="font-mono text-[10px] tabular-nums text-ink-muted group-hover:text-ink">
                      {player.totalScore.toFixed(1)}
                    </span>
                  </button>
                ))}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Search Header */}
      <div className="p-4 border-b border-rule">
        <div className="flex items-center gap-4">
          <div className="flex-1 relative">
            <Search className="absolute left-3 top-1/2 transform -translate-y-1/2 w-4 h-4 text-ink-faint" />
            <input
              ref={searchInputRef}
              type="text"
              aria-label="Search players by name or BIB. Press slash to focus search."
              placeholder="Search by name or BIB · press /"
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)}
              className="w-full pl-10 pr-8 py-2 border border-rule rounded-sharp bg-surface text-ink text-sm placeholder:text-ink-faint focus:outline-none focus:border-ink transition-colors"
            />
            {searchTerm && (
              <button
                onClick={() => setSearchTerm('')}
                className="absolute right-3 top-1/2 transform -translate-y-1/2"
                title="Clear search"
              >
                <X className="w-4 h-4 text-ink-faint hover:text-ink" />
              </button>
            )}
          </div>

          {/* Show All Toggle */}
          <button
            onClick={() => setShowAllPlayers(!showAllPlayers)}
            className={`flex items-center gap-2 px-3 py-2 rounded-sharp text-xs font-semibold uppercase tracking-button transition-colors ${
              showAllPlayers
                ? 'bg-ink text-surface'
                : 'border border-rule text-ink-muted hover:text-ink hover:border-rule-strong'
            }`}
            title={showAllPlayers ? 'Showing all players' : 'Showing available only'}
          >
            <Users className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">{showAllPlayers ? 'All players' : 'Available only'}</span>
          </button>

          <span className="font-mono text-[11px] uppercase tracking-label text-ink-muted whitespace-nowrap">
            {showAllPlayers
              ? `${sortedPlayers.length} players · ${availableCount} available`
              : `${sortedPlayers.length} available`
            }
          </span>
        </div>
      </div>

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-surface-2 border-b border-rule">
              <th
                onClick={() => handleSort('round')}
                className={`${thSortable} text-center w-16`}
                title="Projected Round"
              >
                Proj<SortIndicator field="round" />
              </th>
              {showAllPlayers && (
                <th
                  onClick={() => handleSort('draftedRound')}
                  className={`${thSortable} text-center w-14`}
                  title="Round Drafted"
                >
                  Drafted<SortIndicator field="draftedRound" />
                </th>
              )}
              <th
                onClick={() => handleSort('rank')}
                className={`${thSortable} text-center w-14`}
              >
                Rank<SortIndicator field="rank" />
              </th>
              <th
                onClick={() => handleSort('bib')}
                className={`${thSortable} text-center w-14`}
              >
                BIB<SortIndicator field="bib" />
              </th>
              <th
                onClick={() => handleSort('allstar')}
                className={`${thSortable} text-center w-8 px-1`}
                title="All-Star"
              >
                <span>⭐</span><SortIndicator field="allstar" />
              </th>
              <th
                onClick={() => handleSort('name')}
                className={`${thSortable} text-left`}
              >
                Name<SortIndicator field="name" />
              </th>
              <th
                onClick={() => handleSort('age')}
                className={`${thSortable} text-center w-12`}
              >
                Age<SortIndicator field="age" />
              </th>
              <th
                onClick={() => handleSort('school')}
                className={`${thSortable} text-left w-24`}
              >
                School<SortIndicator field="school" />
              </th>
              <th
                onClick={() => handleSort('team')}
                className={`${thSortable} text-left w-24`}
              >
                Team<SortIndicator field="team" />
              </th>
              {showScores && (
                <>
                  <th
                    onClick={() => handleSort('fielding')}
                    className={`${thSortable} text-center w-14`}
                    title="Fielding"
                  >
                    Field<SortIndicator field="fielding" />
                  </th>
                  <th
                    onClick={() => handleSort('hitting')}
                    className={`${thSortable} text-center w-14`}
                    title="Hitting"
                  >
                    Hit<SortIndicator field="hitting" />
                  </th>
                  <th
                    onClick={() => handleSort('pitching')}
                    className={`${thSortable} text-center w-14`}
                    title="Pitching"
                  >
                    Pitch<SortIndicator field="pitching" />
                  </th>
                  <th
                    onClick={() => handleSort('catch')}
                    className={`${thSortable} text-center w-14`}
                    title="Catching"
                  >
                    Catch<SortIndicator field="catch" />
                  </th>
                  <th
                    onClick={() => handleSort('running')}
                    className={`${thSortable} text-center w-14`}
                    title="Running"
                  >
                    Run<SortIndicator field="running" />
                  </th>
                  <th
                    onClick={() => handleSort('total')}
                    className={`${thSortable} text-center w-14 border-l border-rule`}
                  >
                    Total<SortIndicator field="total" />
                  </th>
                </>
              )}
              <th className="px-2 py-2 text-center text-xs font-semibold uppercase tracking-label text-ink-muted w-16">
                Flags
              </th>
              <th
                onClick={() => handleSort('sibling')}
                className={`${thSortable} text-center w-14`}
                title="Sibling BIB"
              >
                Sib<SortIndicator field="sibling" />
              </th>
              {!isReadOnly && (
                <th className="px-2 py-2 text-center text-xs font-semibold uppercase tracking-label text-ink-muted w-16">
                  Action
                </th>
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-rule">
            {sortedPlayers.map((player) => {
              const isMandatory = mandatoryPick?.playerId === player.id;
              const isRestricted = isPlayerRestricted(player);
              const isAgeMaxed = isPlayerAgeMaxed(player);
              const teamName = getPlayerTeamName(player);
              const siblingBib = getSiblingBib(player);
              const effectiveRound = player.lockedToRound ?? player.projectedRound;
              const hasRoundOverride = player.lockedToRound && player.lockedToRound !== player.projectedRound;
              const isLockedToTeam = (player.isCoachKid && player.coachTeamId) || player.lockedToTeamId;
              const isLockedToOtherTeam = isLockedToTeam && !player.isDrafted &&
                ((player.isCoachKid && player.coachTeamId !== currentTeamId) ||
                 (player.lockedToTeamId && player.lockedToTeamId !== currentTeamId));

              const rowState = player.isDrafted
                ? 'bg-surface-2 opacity-50'
                : isMandatory && !isReadOnly
                ? 'bg-brand-soft'
                : isLockedToOtherTeam
                ? 'bg-alert-soft opacity-60'
                : '';

              return (
                <tr
                  key={player.id}
                  className={`hover:bg-surface-2 transition-colors ${rowState}`}
                >
                  {/* Projected Round */}
                  <td className="px-2 py-1.5 text-center">
                    <span
                      className={`font-mono tabular-nums ${
                        hasRoundOverride
                          ? 'text-brand font-semibold'
                          : 'text-ink-muted'
                      }`}
                      title={
                        hasRoundOverride
                          ? `Bumped to R${player.lockedToRound} to resolve a conflict (originally projected R${player.projectedRound})`
                          : `Projected round ${effectiveRound}`
                      }
                    >
                      R{effectiveRound}
                      {hasRoundOverride && '*'}
                    </span>
                  </td>

                  {/* Drafted Round (only when showing all players) */}
                  {showAllPlayers && (
                    <td className="px-2 py-1.5 text-center">
                      {player.isDrafted && player.draftedInRound ? (
                        <span className="font-mono text-xs tabular-nums text-ink-muted">
                          R{player.draftedInRound}
                        </span>
                      ) : (
                        <span className="text-ink-faint">–</span>
                      )}
                    </td>
                  )}

                  {/* Rank */}
                  <td className="px-2 py-1.5 text-center font-mono text-ink-muted tabular-nums">
                    {player.rank}
                  </td>

                  {/* BIB */}
                  <td className="px-2 py-1.5 text-center">
                    <span className="font-mono text-xs tabular-nums bg-surface text-ink-muted border border-rule px-1.5 py-0.5 rounded-sharp">
                      {player.bib}
                    </span>
                  </td>

                  {/* All-Star */}
                  <td className="px-1 py-1.5 text-center">
                    {player.isAllStar && <span title="All-Star">⭐</span>}
                  </td>

                  {/* Name */}
                  <td className="px-2 py-1.5 text-left">
                    <span className={`font-medium ${
                      isRestricted ? 'text-ink-faint' : 'text-ink'
                    }`}>
                      {player.name}
                    </span>
                  </td>

                  {/* Age */}
                  <td className="px-2 py-1.5 text-center font-mono text-ink-muted tabular-nums">
                    {player.littleLeagueAge}
                  </td>

                  {/* School */}
                  <td
                    className="px-2 py-1.5 text-left text-ink-muted text-xs truncate max-w-[6rem]"
                    title={player.school || undefined}
                  >
                    {player.school || '–'}
                  </td>

                  {/* Team */}
                  <td className="px-2 py-1.5 text-left">
                    {teamName ? (
                      <span
                        className={`inline-flex items-center gap-0.5 text-xs font-medium truncate max-w-[5.5rem] ${
                          player.isDrafted
                            ? 'text-ink-muted'
                            : isLockedToOtherTeam
                            ? 'text-alert'
                            : 'text-brand'
                        }`}
                        title={player.isDrafted ? `Drafted by ${teamName}` : (player.isCoachKid ? `Coach's kid (${teamName})` : `Locked to ${teamName}`)}
                      >
                        {!player.isDrafted && isLockedToTeam && <Lock className="w-2.5 h-2.5 flex-shrink-0" />}
                        <span className="truncate">{teamName}</span>
                      </span>
                    ) : (
                      <span className="text-ink-faint">–</span>
                    )}
                  </td>

                  {/* Score Columns */}
                  {showScores && (
                    <>
                      <td className={`px-2 py-1.5 text-center font-mono tabular-nums ${
                        isRestricted ? 'text-ink-faint' : 'text-ink-muted'
                      }`}>
                        {player.fieldingSubtotal.toFixed(1)}
                      </td>
                      <td className={`px-2 py-1.5 text-center font-mono tabular-nums ${
                        isRestricted ? 'text-ink-faint' : 'text-ink-muted'
                      }`}>
                        {player.hittingSubtotal.toFixed(1)}
                      </td>
                      <td className={`px-2 py-1.5 text-center font-mono tabular-nums ${
                        isRestricted ? 'text-ink-faint' : 'text-ink-muted'
                      }`}>
                        {player.pitchingSubtotal.toFixed(1)}
                      </td>
                      <td className={`px-2 py-1.5 text-center font-mono tabular-nums ${
                        isRestricted ? 'text-ink-faint' : 'text-ink-muted'
                      }`}>
                        {player.catchScore.toFixed(1)}
                      </td>
                      <td className={`px-2 py-1.5 text-center font-mono tabular-nums ${
                        isRestricted ? 'text-ink-faint' : 'text-ink-muted'
                      }`}>
                        {player.runningScore.toFixed(1)}
                      </td>
                      <td className={`px-2 py-1.5 text-center font-mono tabular-nums font-semibold border-l border-rule ${
                        isRestricted ? 'text-ink-faint' : 'text-ink'
                      }`}>
                        {player.totalScore.toFixed(1)}
                      </td>
                    </>
                  )}

                  {/* Flags — monochrome letter-glyphs; the letter carries the meaning */}
                  <td className="px-2 py-1.5">
                    <div className="flex items-center justify-center gap-1 flex-wrap">
                      {player.isDNE && (
                        <span
                          className="font-mono text-[10px] font-semibold uppercase tracking-label px-1.5 py-0.5 rounded-sharp border border-rule bg-surface text-ink-muted"
                          title="Did Not Evaluate"
                        >
                          DNE
                        </span>
                      )}

                      {player.siblingId && (
                        <span
                          className="font-mono text-[10px] font-semibold uppercase tracking-label px-1.5 py-0.5 rounded-sharp border border-rule bg-surface text-ink-muted"
                          title={`Sibling: ${player.sibling || 'linked'}`}
                        >
                          SIB
                        </span>
                      )}

                      {isAgeMaxed && (
                        <span
                          className="font-mono text-[10px] font-semibold uppercase tracking-label px-1.5 py-0.5 rounded-sharp border border-warn bg-surface text-warn"
                          title={`Age ${player.littleLeagueAge} at limit`}
                        >
                          Age
                        </span>
                      )}
                    </div>
                  </td>

                  {/* Sibling BIB */}
                  <td className="px-2 py-1.5 text-center">
                    {siblingBib ? (
                      <span
                        className="font-mono text-xs tabular-nums text-ink-muted"
                        title={`Sibling: ${player.sibling || 'linked'}`}
                      >
                        {siblingBib}
                      </span>
                    ) : (
                      <span className="text-ink-faint">–</span>
                    )}
                  </td>

                  {/* Action */}
                  {!isReadOnly && (
                    <td className="px-2 py-1.5 text-center">
                      {!isRestricted && (
                        <button
                          onClick={() => handleDraft(player)}
                          disabled={isLoading}
                          className="bg-brand hover:bg-brand-strong text-white text-[11px] font-semibold uppercase tracking-button px-3 py-1 rounded-button disabled:opacity-50 transition-colors"
                        >
                          Draft
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
            {sortedPlayers.length === 0 && (
              <tr>
                <td
                  colSpan={getColumnCount()}
                  className="px-3 py-8 text-center text-ink-muted"
                >
                  {searchTerm ? 'No players match your search' : 'No available players'}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Legend */}
      <div className="px-4 py-2.5 border-t border-rule bg-surface-2">
        <div className="flex items-center gap-4 text-xs text-ink-muted flex-wrap">
          <div className="flex items-center gap-1.5">
            <Lock className="w-3 h-3" />
            <span>Locked to team</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span>⭐</span>
            <span>All-Star</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-label px-1 py-0.5 rounded-sharp border border-rule bg-surface text-ink-muted">SIB</span>
            <span>Sibling</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-label px-1 py-0.5 rounded-sharp border border-rule bg-surface text-ink-muted">DNE</span>
            <span>Did not evaluate</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-[10px] font-semibold uppercase tracking-label px-1 py-0.5 rounded-sharp border border-warn bg-surface text-warn">Age</span>
            <span>At age limit</span>
          </div>
          <div className="flex items-center gap-1.5">
            <span className="font-mono text-xs text-brand font-semibold">R#*</span>
            <span>Round bumped to resolve conflict</span>
          </div>
        </div>
      </div>
    </div>
  );
};
