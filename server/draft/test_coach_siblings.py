from django.test import TestCase

from .models import Division, Organization, Player, Team
from .services_draft import DraftService
from .services_readiness import RuleCheckError, evaluate_pick
from .transformers import transform_player


class CoachSiblingTests(TestCase):
    def setUp(self):
        organization = Organization.objects.create(name="League", slug="league")
        self.division = Division.objects.create(
            organization=organization, name="AA", preset="AA", age_range_min=7,
            age_range_max=10, team_count=5, roster_size=2, enforce_age_limit=False,
        )
        self.teams = [Team.objects.create(division=self.division, draft_position=i) for i in range(1, 6)]
        self.cedar = Player.objects.create(
            division=self.division, bib="1", name="Cedar", first_name="Cedar", last_name="",
            little_league_age=9, total_score=100, projected_round=2,
        )
        self.delta = Player.objects.create(
            division=self.division, bib="2", name="Delta", first_name="Delta", last_name="",
            little_league_age=9, total_score=90, projected_round=2,
            is_coach_kid=True, coach_team=self.teams[4], sibling_id=self.cedar.id,
        )
        self.cedar.sibling_id = self.delta.id
        self.cedar.save()
        self.singles = [Player.objects.create(
            division=self.division, bib=str(i + 3), name=f"Single {i}", first_name="Single", last_name=str(i),
            little_league_age=9, total_score=80 - i, projected_round=1,
        ) for i in range(8)]
        self.state = DraftService.start_draft(self.division.id, "straight", [team.id for team in self.teams])

    def test_splitting_coach_family_requires_override_and_preserves_coach_assignment(self):
        with self.assertRaises(RuleCheckError) as error:
            DraftService.draft_player(self.state.id, self.cedar.id, self.teams[0].id)
        self.assertIn({
            "code": "sibling_coach_conflict", "level": "block",
            "message": "Cedar's sibling Delta is Team 5's coach kid — drafting splits them; Team 5 should take Cedar",
        }, error.exception.warnings)
        self.assertFalse(self.state.picks.exists())
        self.state = DraftService.draft_player(
            self.state.id, self.cedar.id, self.teams[0].id, acknowledge_warnings=True,
        )
        self.delta.refresh_from_db()
        self.assertEqual(self.delta.coach_team_id, self.teams[4].id)
        self.assertIsNone(self.delta.locked_to_team_id)
        self.assertTrue(self.state.audit_events.filter(action="pick").last().details["overridden_warnings"])
        serialized = transform_player(self.delta)
        self.assertEqual(serialized["coach_team_id"], str(self.teams[4].id))
        self.assertIsNone(serialized["locked_to_team_id"])

    def test_reverse_sibling_link_cannot_lock_coach_kid_to_another_team(self):
        self.cedar.sibling_id = None
        self.cedar.save()
        DraftService.draft_player(self.state.id, self.cedar.id, self.teams[0].id, acknowledge_warnings=True)
        self.delta.refresh_from_db()
        self.assertIsNone(self.delta.locked_to_team_id)
        self.assertEqual(self.delta.coach_team_id, self.teams[4].id)

    def test_foreign_coach_kid_never_becomes_sibling_mandatory_pick(self):
        self.delta.locked_to_team = self.teams[0]
        self.delta.save()
        DraftService._check_and_set_mandatory_pick(self.state, self.teams[0], 2)
        self.state.refresh_from_db()
        self.delta.refresh_from_db()
        self.assertIsNone(self.state.mandatory_player_id)
        self.assertIsNone(self.delta.locked_to_team_id)
        DraftService._check_and_set_mandatory_pick(self.state, self.teams[4], 2)
        self.state.refresh_from_db()
        self.assertEqual(self.state.mandatory_player_id, self.delta.id)
        self.assertEqual(self.state.mandatory_reason, "coach-kid")

    def test_coach_kid_cannot_be_drafted_by_wrong_team_even_with_override(self):
        with self.assertRaisesMessage(ValueError, "Coach's kid must be drafted by their coach's team"):
            DraftService.draft_player(self.state.id, self.delta.id, self.teams[0].id, acknowledge_warnings=True)

    def test_conflict_is_still_block_level_for_a_mandatory_sibling(self):
        self.state.mandatory_player = self.cedar
        warnings = evaluate_pick(self.state, self.cedar, self.teams[0])
        self.assertTrue(any(w["code"] == "sibling_coach_conflict" and w["level"] == "block" for w in warnings))
        own_team_warnings = evaluate_pick(self.state, self.cedar, self.teams[4])
        self.assertFalse(any(w["code"] == "sibling_coach_conflict" for w in own_team_warnings))

    def test_normal_sibling_lock_is_unchanged(self):
        self.delta.is_coach_kid = False
        self.delta.coach_team = None
        self.delta.save()
        DraftService.draft_player(self.state.id, self.cedar.id, self.teams[0].id)
        self.delta.refresh_from_db()
        self.assertEqual(self.delta.locked_to_team_id, self.teams[0].id)

    def set_stale_mandatory(self):
        self.delta.locked_to_team = self.teams[0]
        self.delta.save()
        self.state.mandatory_player = self.delta
        self.state.mandatory_reason = "sibling"
        self.state.mandatory_sibling_name = self.cedar.name
        self.state.save()

    def test_resume_can_draft_alternative_to_foreign_coach_mandatory(self):
        self.set_stale_mandatory()
        state = DraftService.draft_player(self.state.id, self.singles[0].id, self.teams[0].id)
        self.assertEqual(state.picks.count(), 1)
        self.assertIsNone(state.mandatory_player_id)
        self.delta.refresh_from_db()
        self.assertIsNone(self.delta.locked_to_team_id)

    def test_resume_can_skip_after_repairing_foreign_coach_mandatory(self):
        self.singles[0].delete()
        self.set_stale_mandatory()
        state = DraftService.skip_pick(self.state.id, self.teams[0].id)
        self.assertTrue(state.picks.first().was_skipped)

    def test_repair_recomputes_valid_mandatory_and_does_not_bypass_it(self):
        self.set_stale_mandatory()
        own_child = self.singles[0]
        own_child.is_coach_kid = True
        own_child.coach_team = self.teams[0]
        own_child.projected_round = 1
        own_child.save()
        with self.assertRaisesMessage(ValueError, "mandatory player"):
            DraftService.draft_player(self.state.id, self.singles[1].id, self.teams[0].id)
        with self.assertRaisesMessage(ValueError, "mandatory pick required"):
            DraftService.skip_pick(self.state.id, self.teams[0].id)
        state = DraftService.draft_player(self.state.id, own_child.id, self.teams[0].id)
        self.assertEqual(state.picks.first().player_id, own_child.id)
