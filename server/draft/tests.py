import json

from django.test import TestCase

from .models import Division, Organization, OrganizationMembership, Team, User


class TeamCreateTenantIsolationTests(TestCase):
    def setUp(self):
        self.org_a = Organization.objects.create(name="Org A", slug="org-a")
        self.org_b = Organization.objects.create(name="Org B", slug="org-b")
        self.user = User.objects.create_user(email="a@example.com", password="Passw0rd!x")
        OrganizationMembership.objects.create(user=self.user, organization=self.org_a, role="admin")
        self.own_division = Division.objects.create(organization=self.org_a, name="Majors", preset="majors", age_range_min=10, age_range_max=12, team_count=4)
        self.foreign_division = Division.objects.create(organization=self.org_b, name="Majors", preset="majors", age_range_min=10, age_range_max=12, team_count=4)
        self.client.force_login(self.user)

    def _create_team(self, division_id, **headers):
        return self.client.post(
            "/api/teams/",
            data=json.dumps({"division_id": str(division_id), "name": "Sharks", "draft_position": 1}),
            content_type="application/json",
            **headers,
        )

    def test_create_team_in_own_division(self):
        response = self._create_team(self.own_division.id)
        self.assertEqual(response.status_code, 201)
        self.assertEqual(Team.objects.filter(division=self.own_division).count(), 1)

    def test_create_team_in_foreign_division_returns_404(self):
        response = self._create_team(self.foreign_division.id)
        self.assertEqual(response.status_code, 404)
        self.assertFalse(Team.objects.filter(division=self.foreign_division).exists())

    def test_create_team_without_organization_returns_404(self):
        outsider = User.objects.create_user(email="m@example.com", password="Passw0rd!x")
        self.client.force_login(outsider)
        response = self._create_team(self.own_division.id)
        self.assertEqual(response.status_code, 404)
        self.assertFalse(Team.objects.exists())

    def test_create_team_with_invalid_division_id_returns_404(self):
        response = self._create_team("not-a-uuid")
        self.assertEqual(response.status_code, 404)

    def test_master_admin_can_create_team_in_any_division(self):
        admin = User.objects.create_user(email="admin@example.com", password="Passw0rd!x", role="master_admin")
        self.client.force_login(admin)
        response = self._create_team(self.foreign_division.id)
        self.assertEqual(response.status_code, 201)

    def test_user_without_organization_can_create_team_in_personal_division(self):
        solo = User.objects.create_user(email="solo@example.com", password="Passw0rd!x")
        personal = Division.objects.create(owner=solo, name="Personal", preset="custom", age_range_min=8, age_range_max=12, team_count=4)
        self.client.force_login(solo)
        response = self._create_team(personal.id)
        self.assertEqual(response.status_code, 201)
