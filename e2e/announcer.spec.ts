import { test, expect } from '@playwright/test';
import { buildAnnouncement, newestAppendedPick } from '../src/utils/draftAnnouncer';
import type { DraftPick, Player, Team } from '../src/types';

const pick: DraftPick = { round: 2, pick: 2, teamId: 't', playerId: 'p' };
const teams = Array.from({ length: 10 }, (_, index) => ({
  id: index === 0 ? 't' : `t${index}`, teamName: 'Tigers', draftPosition: index + 1,
})) as Team[];
const players = [{ id: 'p', firstName: 'Ava', lastName: 'Garcia' }] as Player[];

test('announcement uses overall pick, display name and full player name', () => {
  expect(buildAnnouncement(pick, teams, players)).toBe('With pick 12, the Tigers select Ava Garcia.');
  expect(buildAnnouncement(pick, [{ ...teams[0], teamName: '', headCoach: 'Garcia' }], players))
    .toBe('With pick 3, the Garcia select Ava Garcia.');
});

test('missing entities and skipped picks have no sentence', () => {
  expect(buildAnnouncement(pick, [], players)).toBeNull();
  expect(buildAnnouncement(pick, teams, [])).toBeNull();
  expect(buildAnnouncement({ ...pick, wasSkipped: true }, teams, players)).toBeNull();
});

test('only the latest newly appended non-skipped pick is selected', () => {
  expect(newestAppendedPick([], [pick])).toEqual(pick);
  expect(newestAppendedPick([], [pick, { ...pick, pick: 3 }])).toEqual({ ...pick, pick: 3 });
  expect(newestAppendedPick([pick], [pick])).toBeNull();
  expect(newestAppendedPick([], [])).toBeNull();
  expect(newestAppendedPick([pick], [])).toBeNull();
  expect(newestAppendedPick([pick], [{ ...pick, playerId: 'other' }])).toBeNull();
  expect(newestAppendedPick([pick], [{ ...pick, playerId: 'other' }, pick])).toBeNull();
  expect(newestAppendedPick([], [{ ...pick, wasSkipped: true }])).toBeNull();
  expect(newestAppendedPick([], [{ ...pick, playerId: undefined }])).toBeNull();
});
