from uuid import uuid4

from .models import Organization, OrganizationMembership
from .tests import CrossTenantTestBase, _make_division


class TenantHeaderTests(CrossTenantTestBase):
    def setUp(self):
        super().setUp()
        second = Organization.objects.create(name="Second", slug="second")
        OrganizationMembership.objects.create(user=self.victim_admin, organization=second, role="coach")
        self.personal = _make_division(None, "Personal", owner=self.victim_admin)
        self.client.force_login(self.victim_admin)

    def test_invalid_headers_fail_closed_on_lists_and_details(self):
        for header in ("HTTP_X_ORGANIZATION_ID", "HTTP_X_LEAGUE_ID"):
            for value in (str(self.attacker_org.id), str(uuid4()), "malformed", ""):
                for url in ("/api/divisions/", f"/api/divisions/{self.personal.id}/", f"/api/divisions/{self.victim_division.id}/"):
                    with self.subTest(header=header, value=value, url=url):
                        response = self.client.get(url, **{header: value})
                        self.assertEqual(response.status_code, 403)
                        self.assertEqual(response.json(), {
                            "error": "You do not have access to the selected organization.",
                            "code": "invalid_organization",
                        })

    def test_no_header_preserves_personal_and_valid_member_header_preserves_access(self):
        response = self.client.get("/api/divisions/")
        self.assertEqual(response.status_code, 200)
        self.assertEqual([item["id"] for item in response.json()], [str(self.personal.id)])
        self.assertEqual(self.client.get(f"/api/divisions/{self.personal.id}/").status_code, 200)
        for header in ("HTTP_X_ORGANIZATION_ID", "HTTP_X_LEAGUE_ID"):
            headers = {header: str(self.victim_org.id)}
            response = self.client.get("/api/divisions/", **headers)
            self.assertEqual(response.status_code, 200)
            self.assertIn(str(self.victim_division.id), [item["id"] for item in response.json()])
            self.assertEqual(self.client.get(f"/api/divisions/{self.victim_division.id}/", **headers).status_code, 200)

    def test_master_admin_still_accepts_nonmember_and_nonexistent_organizations(self):
        self.victim_admin.role = "master_admin"
        self.victim_admin.save(update_fields=["role"])
        for value in (str(self.attacker_org.id), str(uuid4())):
            response = self.client.get("/api/divisions/", HTTP_X_ORGANIZATION_ID=value)
            self.assertEqual(response.status_code, 200)
