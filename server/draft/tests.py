from django.test import TestCase

from .models import Division, Organization, OrganizationMembership, Player, Team, User


class CoachKidCrossTenantTests(TestCase):
    def setUp(self):
        self.victim_org = Organization.objects.create(name="Acme", slug="acme")
        victim_division = Division.objects.create(
            organization=self.victim_org, name="Majors", preset="majors",
            age_range_min=10, age_range_max=12, team_count=2,
        )
        self.victim_team = Team.objects.create(division=victim_division, name="Acme Team", draft_position=1)
        self.victim_player = Player.objects.create(
            division=victim_division, bib="1", first_name="Vic", last_name="Tim",
            name="Vic Tim", little_league_age=11, birthday="2014-01-01",
            is_coach_kid=True, coach_team=self.victim_team,
        )

        attacker_org = Organization.objects.create(name="Mallory", slug="mallory")
        attacker_division = Division.objects.create(
            organization=attacker_org, name="Majors", preset="majors",
            age_range_min=10, age_range_max=12, team_count=1,
        )
        self.attacker_team = Team.objects.create(division=attacker_division, name="M Team", draft_position=1)
        self.own_player = Player.objects.create(
            division=attacker_division, bib="1", first_name="Own", last_name="Kid",
            name="Own Kid", little_league_age=11, birthday="2014-01-01",
        )
        attacker = User.objects.create_user(email="mallory@example.com", password="x")
        OrganizationMembership.objects.create(user=attacker, organization=attacker_org, role="admin")
        self.client.force_login(attacker)

    def test_assign_rejects_player_from_other_division(self):
        response = self.client.post(
            f"/api/teams/{self.attacker_team.id}/coach-kids/",
            {"player_id": str(self.victim_player.id)},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 404)
        self.victim_player.refresh_from_db()
        self.assertTrue(self.victim_player.is_coach_kid)
        self.assertEqual(self.victim_player.coach_team_id, self.victim_team.id)

    def test_remove_rejects_player_from_other_division(self):
        response = self.client.delete(
            f"/api/teams/{self.attacker_team.id}/coach-kids/{self.victim_player.id}/"
        )
        self.assertEqual(response.status_code, 404)
        self.victim_player.refresh_from_db()
        self.assertTrue(self.victim_player.is_coach_kid)
        self.assertEqual(self.victim_player.coach_team_id, self.victim_team.id)

    def test_assign_and_remove_player_in_same_division(self):
        response = self.client.post(
            f"/api/teams/{self.attacker_team.id}/coach-kids/",
            {"player_id": str(self.own_player.id)},
            content_type="application/json",
        )
        self.assertEqual(response.status_code, 200)
        self.own_player.refresh_from_db()
        self.assertTrue(self.own_player.is_coach_kid)
        self.assertEqual(self.own_player.coach_team_id, self.attacker_team.id)

        response = self.client.delete(
            f"/api/teams/{self.attacker_team.id}/coach-kids/{self.own_player.id}/"
        )
        self.assertEqual(response.status_code, 204)
        self.own_player.refresh_from_db()
        self.assertFalse(self.own_player.is_coach_kid)
        self.assertIsNone(self.own_player.coach_team_id)
