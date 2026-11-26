import { DraftPick, PickWarning, Player, Team } from '../types';
import { getTeamDisplayName } from './teamUtils';

export const ROSTER_BALANCE_RATIO = 1.15;

export interface DraftSafetyConfig {
  enforceAgeLimit: boolean;
  maxPerAge: number;
  ageRange: { min: number; max: number };
  rosterSize: number;
  teamCount: number;
  teams?: Team[];
}

export function getPickWarnings(
  player: Player, team: Team, players: Player[], picks: DraftPick[],
  config: DraftSafetyConfig, mandatoryPlayerId?: string,
): PickWarning[] {
  const warnings: PickWarning[] = [];
  const teamName = getTeamDisplayName(team);
  const add = (code: string, level: PickWarning['level'], message: string) => {
    warnings.push({ code, level: mandatoryPlayerId === player.id ? 'warn' : level, message });
  };
  const roster = players.filter(p => p.isDrafted && p.draftedByTeamId === team.id);
  const ageCount = roster.filter(p => p.littleLeagueAge === player.littleLeagueAge).length;
  if (config.enforceAgeLimit && config.maxPerAge > 0) {
    if (ageCount >= config.maxPerAge) {
      add('age_cap', 'block', `${teamName} already has the maximum players of age ${player.littleLeagueAge}`);
    } else if (ageCount + 1 === config.maxPerAge) {
      add('age_cap', 'warn', `This pick reaches the age ${player.littleLeagueAge} cap`);
    }
  }
  if (player.littleLeagueAge < config.ageRange.min || player.littleLeagueAge > config.ageRange.max) {
    add('age_range', 'warn', `${player.name} is outside the division age range`);
  }

  const group = new Set([player.id]);
  const byId = new Map(players.map(p => [p.id, p]));
  let changed = true;
  while (changed) {
    const previousSize = group.size;
    for (const p of players) {
      if (p.siblingId && group.has(p.siblingId)) group.add(p.id);
      if (group.has(p.id) && p.siblingId && byId.has(p.siblingId)) group.add(p.siblingId);
    }
    changed = previousSize !== group.size;
  }
  const coachSiblings = players.filter(p => p.id !== player.id && group.has(p.id)
    && p.isCoachKid && p.coachTeamId && p.coachTeamId !== team.id);
  for (const sibling of coachSiblings) {
    const coachTeam = config.teams?.find(team => team.id === sibling.coachTeamId);
    const coachTeamName = coachTeam ? getTeamDisplayName(coachTeam) : 'their coach’s team';
    warnings.push({ code: 'sibling_coach_conflict', level: 'block',
      message: `${player.name.trim()}'s sibling ${sibling.name.trim()} is ${coachTeamName}'s coach kid — drafting splits them; ${coachTeamName} should take ${player.name.trim()}` });
  }
  const siblings = players.filter(p => p.id !== player.id && group.has(p.id) && !p.isDrafted && !p.lockedToTeamId
    && !(p.isCoachKid && p.coachTeamId && p.coachTeamId !== team.id));
  const owed = new Set(players.filter(p => !p.isDrafted && p.id !== player.id && (
    (p.isCoachKid && p.coachTeamId === team.id) || p.lockedToTeamId === team.id
  )).map(p => p.id));
  siblings.forEach(p => owed.add(p.id));
  const remaining = config.rosterSize - picks.filter(p => p.teamId === team.id).length - 1;
  if (siblings.length && remaining < owed.size) {
    add('sibling_capacity', 'block', `${teamName} lacks remaining picks for mandatory players and siblings`);
  }
  for (const sibling of siblings) {
    add('sibling_lock', 'warn', `Drafting ${player.name} locks sibling ${sibling.name} to ${teamName} in round ${sibling.lockedToRound || sibling.projectedRound}`);
  }
  const drafted = players.filter(p => p.isDrafted);
  if (roster.length + 1 >= 2 && drafted.length + 1 >= config.teamCount) {
    const leagueAverage = (drafted.reduce((sum, p) => sum + p.totalScore, 0) + player.totalScore) / (drafted.length + 1);
    const average = (roster.reduce((sum, p) => sum + p.totalScore, 0) + player.totalScore) / (roster.length + 1);
    if (average > ROSTER_BALANCE_RATIO * leagueAverage) {
      add('roster_balance', 'warn', `${teamName}'s average score exceeds 115% of the league average`);
    }
  }
  return warnings;
}
