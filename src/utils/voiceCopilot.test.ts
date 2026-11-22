import { describe, expect, it } from 'vitest';
import { DraftState, Player, Team } from '../types';
import {
  answerVoiceQuery,
  getEligiblePlayers,
  getPlayerEligibility,
  getSuggestedCommands,
  getVoiceKeyterms,
  parseVoiceQuery,
} from './voiceCopilot';

const rules = { enforceAgeLimit: false, maxPerAge: 0 };

const player = (id: string, firstName: string, lastName: string, totalScore: number, extra: Partial<Player> = {}): Player =>
  ({
    id,
    firstName,
    lastName,
    name: `${firstName} ${lastName}`,
    totalScore,
    rank: 1,
    projectedRound: 1,
    littleLeagueAge: 11,
    isCoachKid: false,
    isDrafted: false,
    ...extra,
  }) as Player;

const team = (id: string, headCoach: string, draftPosition: number, extra: Partial<Team> = {}): Team =>
  ({ id, teamName: '', headCoach, assistantCoach: '', draftPosition, roster: [], totalScore: 0, coachKids: [], ageBreakdown: {}, ...extra }) as Team;

const buildState = (overrides: Partial<DraftState> = {}): DraftState => {
  const teams = [team('t1', 'Bonacorsi', 1), team('t2', 'Rivera', 2)];
  const players = [
    player('p1', 'Mason', 'Lee', 90),
    player('p2', 'Ava', 'Stone', 85, { isCoachKid: true, coachTeamId: 't2', projectedRound: 2 }),
    player('p3', 'Leo', 'Park', 80, { lockedToTeamId: 't2' }),
    player('p4', 'Mia', 'Chen', 70),
    player('p5', 'Noah', 'Diaz', 60, { isDrafted: true, draftedByTeamId: 't2', draftedInRound: 1 }),
    player('p6', 'Liam', 'Chen', 50),
  ];
  return {
    players,
    teams,
    draftFormat: 'snake',
    draftOrder: ['t1', 't2'],
    currentRoundOrder: ['t1', 't2'],
    picks: [],
    currentRound: 1,
    currentPickInRound: 1,
    currentTeamId: 't1',
    isDraftComplete: false,
    trades: [],
    ...overrides,
  };
};

const ask = (text: string, state = buildState(), r = rules) => answerVoiceQuery(parseVoiceQuery(text, state), state, r);

describe('parseVoiceQuery', () => {
  it.each([
    ["who's on the clock", 'current-pick'],
    ['whose pick is it', 'current-pick'],
    ['who should we take next', 'next-eligible'],
    ['best available', 'next-eligible'],
    ['who picks next', 'on-deck'],
    ['any mandatory picks', 'mandatory-pick'],
    ['how many picks are left', 'draft-progress'],
    ['what does Rivera have', 'team-roster'],
    ["why can't we take Ava Stone", 'player-status'],
    ['help', 'help'],
    ['the weather is nice', 'unknown'],
  ])('%s -> %s', (text, intent) => {
    expect(parseVoiceQuery(text, buildState()).intent).toBe(intent);
  });

  it.each([
    'draft Mason Lee',
    "let's take Mason Lee",
    'go ahead and draft him',
    'trade Lee for Chen',
    'undo the last pick',
    'skip this pick',
    'reset the draft',
    'please move Mia Chen to Rivera',
  ])('treats "%s" as a roster change', (text) => {
    expect(parseVoiceQuery(text, buildState()).intent).toBe('roster-change');
  });

  it('matches a last name with transcription noise', () => {
    expect(parseVoiceQuery('is Stohne available', buildState()).playerIds).toEqual(['p2']);
  });
});

describe('answers', () => {
  it('reads the current pick', () => {
    expect(ask("who's on the clock").text).toBe('Bonacorsi is on the clock: round 1, pick 1, 1 of 6 overall.');
  });

  it('reads the next eligible player, skipping blocked ones', () => {
    const answer = ask('who is the next eligible player');
    expect(answer.playerId).toBe('p1');
    expect(answer.text).toContain('Mason Lee');
    expect(answer.text).toContain('After that, Mia Chen and Liam Chen.');
  });

  it('explains blocked and drafted players', () => {
    expect(ask("why can't we take Ava Stone").text).toBe("Ava Stone is blocked: coach's kid reserved for Rivera.");
    expect(ask('can we take Leo Park').text).toBe('Leo Park is blocked: sibling locked to Rivera.');
    expect(ask('is Noah Diaz available').text).toBe('Noah Diaz was already drafted by Rivera in round 1.');
    expect(ask('is Mason Lee eligible').text).toBe('Mason Lee is eligible for Bonacorsi.');
  });

  it('asks which player when a last name is shared', () => {
    expect(ask('what about Chen').text).toBe('Which one: Mia Chen and Liam Chen?');
  });

  it('puts the mandatory pick first and explains it blocks others', () => {
    const state = buildState({ currentTeamId: 't2', currentPickInRound: 2, mandatoryPick: { playerId: 'p2', reason: 'coach-kid' } });
    expect(getEligiblePlayers(state, rules).map((p) => p.id)).toEqual(['p2']);
    expect(ask('who should we take', state).text).toBe("Rivera must take Ava Stone (coach's kid).");
    expect(ask('can we take Mason Lee', state).text).toBe(
      "Mason Lee is blocked: Rivera must take Ava Stone first (coach's kid)."
    );
  });

  it('answers mandatory questions for the team that was named', () => {
    const state = buildState({ mandatoryPick: { playerId: 'p1', reason: 'sibling', siblingName: 'Mia Chen' } });
    expect(ask('any mandatory picks for Rivera', state).text).toBe(
      'No mandatory pick for Rivera right now. Still reserved for them: Ava Stone in round 2 and Leo Park in round 1.'
    );
    expect(ask('any mandatory picks', state).text).toBe('Bonacorsi must take Mason Lee this pick (sibling of Mia Chen).');
  });

  it('flags the age cap when it is enforced', () => {
    const state = buildState();
    state.teams[0].ageBreakdown = { '11': 3 };
    const eligibility = getPlayerEligibility(state, state.players[0], { enforceAgeLimit: true, maxPerAge: 3 });
    expect(eligibility.eligible).toBe(false);
    expect(eligibility.reasons[0]).toContain('limit 3');
  });

  it('refuses roster changes', () => {
    expect(ask('draft Mason Lee').text).toContain("can't change rosters by voice");
  });

  it('reads rosters and progress', () => {
    const state = buildState();
    state.teams[1].roster = [state.players[4]];
    state.picks = [{ round: 1, pick: 1, teamId: 't2', playerId: 'p5' }];
    expect(ask('what does Rivera have', state).text).toBe('Rivera has 1 player: Noah Diaz.');
    expect(ask('how many picks are left', state).text).toBe('Round 1 of 3. 1 of 6 picks made, 5 left.');
  });

  it('handles a finished draft', () => {
    expect(ask("who's on the clock", buildState({ isDraftComplete: true, currentTeamId: null })).text).toBe('The draft is complete.');
  });
});

describe('getSuggestedCommands', () => {
  it('suggests the top blocked player on the players screen', () => {
    expect(getSuggestedCommands(buildState(), 'players', rules)).toContain("Why can't we take Ava Stone?");
  });

  it('suggests roster questions on the rosters screen', () => {
    expect(getSuggestedCommands(buildState(), 'rosters', rules)[0]).toBe('What does Bonacorsi have?');
  });

  it('suggests every command it shows is understood', () => {
    const state = buildState({ currentTeamId: 't2', mandatoryPick: { playerId: 'p2', reason: 'coach-kid' } });
    for (const screen of ['players', 'rosters'] as const) {
      for (const s of [buildState(), state]) {
        for (const command of getSuggestedCommands(s, screen, rules)) {
          expect(parseVoiceQuery(command, s).intent).not.toBe('unknown');
        }
      }
    }
  });
});

it('builds keyterms within ElevenLabs limits', () => {
  const terms = getVoiceKeyterms(buildState());
  expect(terms).toContain('Rivera');
  expect(terms.length).toBeLessThanOrEqual(50);
  expect(terms.every((t) => t.length <= 20)).toBe(true);
});
