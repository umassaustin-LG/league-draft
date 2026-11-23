import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { Division, Player, Team, DEFAULT_SCORING_WEIGHTS } from '../types';
import { TeamBuilderFlow } from './TeamBuilderFlow';

const player: Player = {
  id: 'p1', bib: '101', name: 'Avery River', firstName: 'Avery', lastName: 'River',
  fieldScore: 0, throwScore: 0, hitPower: 0, hitForm: 0, hitContact: 0,
  pitchingStrength: 0, pitchingForm: 0, catchScore: 0, runningScore: 0,
  fieldingSubtotal: 0, hittingSubtotal: 0, pitchingSubtotal: 0,
  subjectiveTotal: 0, objectiveTotal: 0, officialAdjust: 0,
  totalScore: 10, rank: 1, projectedRound: 1, littleLeagueAge: 8,
  birthday: '', isAllStar: false, isDNE: false, isCoachKid: false,
  isDrafted: true, draftedByTeamId: 't1', draftedInRound: 1, draftedAtPick: 1,
};
const team: Team = {
  id: 't1', teamName: '', headCoach: 'River Coach', assistantCoach: '', draftPosition: 1,
  roster: [player, { ...player, id: 'p2', totalScore: 20 }], totalScore: 0, coachKids: [], ageBreakdown: { '8': 2 },
};
const division: Division = {
  id: 'division', name: 'AA', preset: 'aa', mode: 'league-generated',
  ageRange: { min: 7, max: 10 }, enforceAgeLimit: false, maxPerAge: 0,
  teamCount: 1, rosterSize: 1, teams: [team], players: [player], draftState: null,
  scoringWeights: DEFAULT_SCORING_WEIGHTS, scoringMode: 'raw', phase: 'upload',
  createdAt: '2026-01-01', isPersonal: true,
};

describe('Team Builder re-entry', () => {
  it('renders saved team rosters without an in-memory algorithm result', () => {
    const html = renderToStaticMarkup(createElement(TeamBuilderFlow, { division, onBack() {} }));
    expect(html).toContain('Saved team rosters');
    expect(html).toContain('Avery River');
    expect(html).toContain('River Coach');
    expect(html).toContain('Adjust &amp; Re-run');
    expect(html).toContain('generate a new request satisfaction report');
    expect(html).not.toContain('Finalize Teams');
    expect(html.replace(/<!--.*?-->/g, '')).toContain('30.0 pts');
    expect(html.replace(/<!--.*?-->/g, '')).toContain('Avg: 15.0 pts');
  });

  it('returns unassigned players to configuration instead of showing empty results', () => {
    const html = renderToStaticMarkup(createElement(TeamBuilderFlow, {
      division: { ...division, players: [{ ...player, isDrafted: false, draftedByTeamId: undefined }], teams: [{ ...team, roster: [] }] },
      onBack() {},
    }));
    expect(html).not.toContain('Saved team rosters');
    expect(html).toContain('Minimum Roster Size');
  });

  it('starts an empty division at setup', () => {
    const html = renderToStaticMarkup(createElement(TeamBuilderFlow, {
      division: { ...division, players: [], teams: [{ ...team, headCoach: '', roster: [] }] },
      onBack() {},
    }));
    expect(html).not.toContain('Saved team rosters');
    expect(html).toContain('Continue to Import');
  });
});
