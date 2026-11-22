import {
  DraftState,
  Player,
  PlayerEligibility,
  Team,
  VoiceCopilotAnswer,
  VoiceCopilotQuery,
} from '../types';
import { calculateDraftOrder, getNextPick } from './draftOrder';
import { getTeamDisplayName } from './teamUtils';
import { nameSimilarity } from './teamBuilderParser';

// The copilot only reads draft state. It never receives or calls draft mutation handlers.

export interface VoiceCopilotRules {
  enforceAgeLimit: boolean;
  maxPerAge: number;
}

export type VoiceCopilotScreen = 'players' | 'rosters';

export const VOICE_COPILOT_COMMANDS = [
  "Who's on the clock?",
  "Who's the next eligible player?",
  "Why can't we take <player>?",
  'What does <team> have?',
  'How many picks are left?',
];

const ROSTER_CHANGE_PATTERNS = [
  /^(?:ok(?:ay)? |hey |please |now |so )*(?:go ahead and |let'?s |can you |could you |you can )?(?:draft|pick|take|select|grab|trade|swap|undo|skip|reset|remove|drop|move|assign|add|put|lock|unlock|delete|release|finalize|confirm|start|restart)\b/,
  /\b(?:let'?s|go ahead and|please|can you|could you) (?:draft|pick|take|select|grab|trade|swap|undo|skip|reset|remove|drop|move|assign|add|put|lock|delete|release|finalize)\b/,
  /\b(?:draft|trade|swap|take|pick) (?:him|her|them|that kid|that player)\b/,
];

const COMMON_WORDS = new Set([
  'who', 'what', 'why', 'when', 'where', 'which', 'how', 'is', 'are', 'was', 'the', 'a', 'an', 'can', 'cant',
  "can't", 'we', 'they', 'i', 'he', 'she', 'it', 'take', 'draft', 'pick', 'next', 'up', 'on', 'clock', 'team',
  'have', 'has', 'does', 'do', 'not', 'eligible', 'available', 'blocked', 'player', 'round', 'will', 'best',
  'still', 'yet', 'any', 'and', 'or', 'of', 'to', 'for', 'about', 'tell', 'me', 'us', 'our', 'my', 'their',
]);

export const normalizeTranscript = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9' ]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const containsPhrase = (text: string, phrase: string): boolean =>
  phrase.length > 0 && ` ${text} `.includes(` ${phrase} `);

export const getCurrentTeam = (state: DraftState): Team | undefined => {
  const teamId = state.currentTeamId || state.currentRoundOrder[state.currentPickInRound - 1];
  return state.teams.find((t) => t.id === teamId);
};

export const getOnDeckTeam = (state: DraftState): Team | undefined => {
  const next = getNextPick(state.currentRound, state.currentPickInRound, state.teams.length);
  const order = next.round === state.currentRound
    ? state.currentRoundOrder
    : calculateDraftOrder(state.teams, next.round, state.draftFormat, state.draftOrder);
  const teamId = order[next.pickInRound - 1];
  return state.teams.find((t) => t.id === teamId);
};

const teamLabel = (state: DraftState, teamId?: string): string => {
  const team = state.teams.find((t) => t.id === teamId);
  return team ? getTeamDisplayName(team) : 'another team';
};

const mandatoryReason = (state: DraftState): string => {
  const mandatory = state.mandatoryPick;
  if (!mandatory) return '';
  return mandatory.reason === 'coach-kid'
    ? "coach's kid"
    : `sibling of ${mandatory.siblingName ?? 'a drafted player'}`;
};

export function getPlayerEligibility(
  state: DraftState,
  player: Player,
  rules: VoiceCopilotRules
): PlayerEligibility {
  if (player.isDrafted) {
    const round = player.draftedInRound ? ` in round ${player.draftedInRound}` : '';
    return { eligible: false, reasons: [`already drafted by ${teamLabel(state, player.draftedByTeamId)}${round}`] };
  }

  const team = getCurrentTeam(state);
  if (!team || state.isDraftComplete) {
    return { eligible: false, reasons: ['no team is on the clock'] };
  }

  const reasons: string[] = [];
  if (player.isCoachKid && player.coachTeamId && player.coachTeamId !== team.id) {
    reasons.push(`coach's kid reserved for ${teamLabel(state, player.coachTeamId)}`);
  }
  if (player.lockedToTeamId && player.lockedToTeamId !== team.id) {
    reasons.push(`sibling locked to ${teamLabel(state, player.lockedToTeamId)}`);
  }

  const mandatory = state.mandatoryPick;
  if (mandatory && mandatory.playerId !== player.id) {
    const required = state.players.find((p) => p.id === mandatory.playerId);
    reasons.push(
      `${getTeamDisplayName(team)} must take ${required?.name ?? 'its required player'} first (${mandatoryReason(state)})`
    );
  }

  if (rules.enforceAgeLimit && rules.maxPerAge > 0) {
    const count = team.ageBreakdown?.[String(player.littleLeagueAge)] ?? 0;
    if (count >= rules.maxPerAge) {
      reasons.push(
        `${getTeamDisplayName(team)} already has ${count} age-${player.littleLeagueAge} players (limit ${rules.maxPerAge}), so it needs an admin override`
      );
    }
  }

  return { eligible: reasons.length === 0, reasons };
}

export function getEligiblePlayers(state: DraftState, rules: VoiceCopilotRules): Player[] {
  const mandatory = state.mandatoryPick && state.players.find((p) => p.id === state.mandatoryPick?.playerId);
  if (mandatory && !mandatory.isDrafted) return [mandatory];
  return state.players
    .filter((p) => !p.isDrafted && getPlayerEligibility(state, p, rules).eligible)
    .sort((a, b) => b.totalScore - a.totalScore);
}

export function findPlayers(transcript: string, players: Player[]): Player[] {
  const text = normalizeTranscript(transcript);
  const words = text.split(' ').filter(Boolean);
  const bigrams = words.slice(0, -1).map((w, i) => `${w} ${words[i + 1]}`);

  const scored = players.map((player) => {
    const full = normalizeTranscript(player.name || `${player.firstName} ${player.lastName}`);
    const first = normalizeTranscript(player.firstName || '');
    const last = normalizeTranscript(player.lastName || '');
    let score = 0;
    if (containsPhrase(text, full)) score = 1;
    else {
      for (const bigram of bigrams) score = Math.max(score, nameSimilarity(bigram, full) >= 0.8 ? 0.9 : 0);
      for (const word of words) {
        if (COMMON_WORDS.has(word) || word.length < 3) continue;
        if (last.length >= 3 && nameSimilarity(word.replace(/'s$/, ''), last) >= 0.8) score = Math.max(score, 0.7);
        if (first.length >= 3 && word === first) score = Math.max(score, 0.6);
      }
    }
    return { player, score };
  });

  const best = Math.max(0, ...scored.map((s) => s.score));
  if (best === 0) return [];
  return scored.filter((s) => s.score === best).map((s) => s.player);
}

export function findTeam(transcript: string, teams: Team[]): Team | undefined {
  const text = normalizeTranscript(transcript);
  return teams.find((team) =>
    [team.teamName, team.headCoach, getTeamDisplayName(team)]
      .filter(Boolean)
      .some((name) => containsPhrase(text, normalizeTranscript(name)))
  );
}

export function parseVoiceQuery(transcript: string, state: DraftState): VoiceCopilotQuery {
  const text = normalizeTranscript(transcript);
  const base = { transcript, playerIds: [] as string[] };

  if (!text) return { ...base, intent: 'unknown' };
  if (ROSTER_CHANGE_PATTERNS.some((pattern) => pattern.test(text))) return { ...base, intent: 'roster-change' };
  if (/\b(help|what can (i|you) (say|do|ask)|commands|options)\b/.test(text)) return { ...base, intent: 'help' };

  const players = findPlayers(text, state.players);
  const team = findTeam(text, state.teams);
  const playerIds = players.map((p) => p.id);
  const teamId = team?.id;
  const rosterWords = /\b(roster|have|has|got|drafted so far|lineup)\b/.test(text);

  if (team && rosterWords && !/\b(why|eligible|available|blocked)\b/.test(text)) {
    return { ...base, intent: 'team-roster', teamId };
  }
  if (players.length > 0) return { ...base, intent: 'player-status', playerIds, teamId };
  if (/\b(mandatory|required|must|have to|has to|forced|coach'?s? kids?|siblings?)\b/.test(text)) {
    return { ...base, intent: 'mandatory-pick', teamId };
  }
  if (/\b(eligible|best available|best player|top player|top available|recommend|suggest|who should|who can (we|they|i)|next player|who do (we|they) take)\b/.test(text)) {
    return { ...base, intent: 'next-eligible' };
  }
  if (/\b(on deck|picks? next|after (this|them|that)|next team|who'?s next|who is next|up next)\b/.test(text)) {
    return { ...base, intent: 'on-deck' };
  }
  if (/\b(on the clock|whose (pick|turn)|who'?s up|who is up|who'?s picking|who is picking|current pick|what pick|which pick|who picks)\b/.test(text)) {
    return { ...base, intent: 'current-pick' };
  }
  if (/\b(what round|which round|how many|picks? left|rounds? left|remaining|progress|how far)\b/.test(text)) {
    return { ...base, intent: 'draft-progress' };
  }
  if (team) return { ...base, intent: 'team-roster', teamId };
  return { ...base, intent: 'unknown' };
}

const totalRoundsFor = (state: DraftState): number =>
  state.teams.length > 0 ? Math.ceil(state.players.length / state.teams.length) : 0;

const describePlayer = (player: Player): string =>
  `${player.name}, age ${player.littleLeagueAge}, ranked ${player.rank}, score ${player.totalScore.toFixed(1)}`;

const listNames = (names: string[]): string => {
  if (names.length <= 1) return names.join('');
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;
};

export function answerVoiceQuery(
  query: VoiceCopilotQuery,
  state: DraftState,
  rules: VoiceCopilotRules
): VoiceCopilotAnswer {
  const { intent } = query;
  const reply = (text: string, extra: Partial<VoiceCopilotAnswer> = {}): VoiceCopilotAnswer => ({ intent, text, ...extra });
  const team = getCurrentTeam(state);
  const teamName = team ? getTeamDisplayName(team) : '';
  const draftOver = state.isDraftComplete || !team;

  switch (intent) {
    case 'help':
      return reply(
        "Ask who's on the clock, who's next eligible, why a player is blocked, what a team has, or how many picks are left. I only answer questions; picks and trades stay on the board."
      );

    case 'roster-change':
      return reply(
        "I can't change rosters by voice. Use the board's buttons for picks, skips, undo and trades so each one is confirmed."
      );

    case 'current-pick': {
      if (draftOver) return reply('The draft is complete.');
      const overall = (state.currentRound - 1) * state.teams.length + state.currentPickInRound;
      const mandatory = state.mandatoryPick && state.players.find((p) => p.id === state.mandatoryPick?.playerId);
      const note = mandatory ? ` They must take ${mandatory.name} (${mandatoryReason(state)}).` : '';
      return reply(
        `${teamName} is on the clock: round ${state.currentRound}, pick ${state.currentPickInRound}, ${overall} of ${state.teams.length * totalRoundsFor(state)} overall.${note}`,
        { teamId: team.id }
      );
    }

    case 'on-deck': {
      if (draftOver) return reply('The draft is complete.');
      const onDeck = getOnDeckTeam(state);
      return onDeck
        ? reply(`${getTeamDisplayName(onDeck)} picks after ${teamName}.`, { teamId: onDeck.id })
        : reply(`${teamName} has the last pick.`);
    }

    case 'next-eligible': {
      if (draftOver) return reply('The draft is complete.');
      const eligible = getEligiblePlayers(state, rules);
      if (eligible.length === 0) return reply(`No player is eligible for ${teamName} right now. The pick may need to be skipped.`);
      const [first, ...rest] = eligible;
      if (state.mandatoryPick) {
        return reply(`${teamName} must take ${first.name} (${mandatoryReason(state)}).`, { playerId: first.id, teamId: team.id });
      }
      const after = rest.slice(0, 2).map((p) => p.name);
      return reply(
        `Next eligible for ${teamName}: ${describePlayer(first)}.${after.length ? ` After that, ${listNames(after)}.` : ''}`,
        { playerId: first.id, teamId: team.id }
      );
    }

    case 'mandatory-pick': {
      if (draftOver) return reply('The draft is complete.');
      const target = state.teams.find((t) => t.id === query.teamId) ?? team;
      const mandatory = state.mandatoryPick && state.players.find((p) => p.id === state.mandatoryPick?.playerId);
      if (mandatory && target.id === team.id) {
        return reply(`${teamName} must take ${mandatory.name} this pick (${mandatoryReason(state)}).`, { playerId: mandatory.id, teamId: team.id });
      }
      const reserved = state.players
        .filter((p) => !p.isDrafted && ((p.isCoachKid && p.coachTeamId === target.id) || p.lockedToTeamId === target.id))
        .map((p) => `${p.name} in round ${p.lockedToRound ?? p.projectedRound}`);
      const upcoming = reserved.length ? ` Still reserved for them: ${listNames(reserved)}.` : '';
      return reply(`No mandatory pick for ${getTeamDisplayName(target)} right now.${upcoming}`, { teamId: target.id });
    }

    case 'player-status': {
      const matches = state.players.filter((p) => query.playerIds.includes(p.id));
      if (matches.length > 1) {
        return reply(`Which one: ${listNames(matches.slice(0, 4).map((p) => p.name))}?`);
      }
      const player = matches[0];
      if (!player) return reply("I couldn't find that player.");
      const eligibility = getPlayerEligibility(state, player, rules);
      if (eligibility.eligible) {
        const required = state.mandatoryPick?.playerId === player.id ? ` and is the required pick (${mandatoryReason(state)})` : '';
        return reply(`${player.name} is eligible for ${teamName}${required}.`, { playerId: player.id });
      }
      if (player.isDrafted) return reply(`${player.name} was ${eligibility.reasons[0]}.`, { playerId: player.id });
      return reply(`${player.name} is blocked: ${eligibility.reasons.join('; ')}.`, { playerId: player.id });
    }

    case 'team-roster': {
      const target = state.teams.find((t) => t.id === query.teamId);
      if (!target) return reply("I couldn't find that team.");
      const names = target.roster.map((p) => p.name);
      if (names.length === 0) return reply(`${getTeamDisplayName(target)} hasn't drafted anyone yet.`, { teamId: target.id });
      const shown = names.slice(0, 8);
      const more = names.length > shown.length ? `, plus ${names.length - shown.length} more` : '';
      return reply(
        `${getTeamDisplayName(target)} has ${names.length} player${names.length === 1 ? '' : 's'}: ${shown.join(', ')}${more}.`,
        { teamId: target.id }
      );
    }

    case 'draft-progress': {
      const totalPicks = state.teams.length * totalRoundsFor(state);
      const made = state.picks.length;
      if (draftOver) return reply(`The draft is complete with ${made} picks.`);
      return reply(
        `Round ${state.currentRound} of ${totalRoundsFor(state)}. ${made} of ${totalPicks} picks made, ${Math.max(totalPicks - made, 0)} left.`
      );
    }

    default:
      return reply(`I didn't catch a draft question. Try "who's next eligible?"`);
  }
}

export function getSuggestedCommands(
  state: DraftState,
  screen: VoiceCopilotScreen,
  rules: VoiceCopilotRules
): string[] {
  const team = getCurrentTeam(state);
  if (state.isDraftComplete || !team) {
    const first = state.teams[0];
    return [first ? `What does ${getTeamDisplayName(first)} have?` : '', 'How many picks were made?'].filter(Boolean);
  }

  const mandatory = state.mandatoryPick && state.players.find((p) => p.id === state.mandatoryPick?.playerId);
  if (mandatory) {
    return [`Why does ${getTeamDisplayName(team)} have to take ${mandatory.name}?`, "Who's on deck?", 'How many picks are left?'];
  }

  if (screen === 'rosters') {
    return [`What does ${getTeamDisplayName(team)} have?`, 'Any mandatory picks coming up?', "Who's on deck?"];
  }

  const blocked = state.players
    .filter((p) => !p.isDrafted && !getPlayerEligibility(state, p, rules).eligible)
    .sort((a, b) => b.totalScore - a.totalScore)[0];
  return [
    "Who's the next eligible player?",
    blocked ? `Why can't we take ${blocked.name}?` : "Who's on the clock?",
    "Who's on deck?",
  ];
}

export function getVoiceKeyterms(state: DraftState): string[] {
  const terms = [
    ...state.teams.flatMap((t) => [t.headCoach, t.teamName]),
    ...state.players.filter((p) => !p.isDrafted).sort((a, b) => b.totalScore - a.totalScore).map((p) => p.lastName),
  ];
  return Array.from(new Set(terms.map((t) => (t || '').trim()).filter((t) => t.length > 1 && t.length <= 20))).slice(0, 50);
}
