"""
URL patterns for the draft app.

Uses plain Django function-based views (no DRF).
"""

from django.urls import path
from .views.draft import draft_readiness_view, draft_pick_check


from .views.elevenlabs import elevenlabs_token, elevenlabs_status, elevenlabs_speak

from .views import (
    # Auth
    health_view,
    csrf_token_view,
    register_view,
    login_view,
    logout_view,
    me_view,
    change_password_view,
    password_reset_request_view,
    password_reset_confirm_view,
    # Divisions
    divisions_list_create,
    division_detail,
    division_reset,
    # Teams
    teams_list_create,
    team_detail,
    teams_bulk_update,
    team_assign_coach_kid,
    team_remove_coach_kid,
    # Players
    players_list_create,
    player_detail,
    players_bulk_create,
    players_delete_by_division,
    # Draft
    draft_retrieve,
    draft_start,
    draft_pick,
    draft_undo,
    draft_skip,
    draft_trade,
    # Leagues
    league_members_list,
    league_member_remove,
    league_member_update_role,
    league_invitations_list_create,
    league_invitation_cancel,
    accept_invitation,
    join_link_view,
    public_join_link_view,
    # Team Builder
    team_builder_run,
    team_builder_apply,
    team_builder_update_requests,
    # Evaluation Templates
    evaluation_templates_list_create,
    evaluation_template_detail,
    # Seasons
    seasons_list_create,
    season_detail,
    # Coach Ratings
    coach_ratings_list_create,
    coach_rating_detail,
    coach_rating_submit,
    coach_ratings_progress,
)

urlpatterns = [
    path("api/elevenlabs/token/", elevenlabs_token, name="elevenlabs-token"),
    path("api/draft/readiness/<uuid:division_id>/", draft_readiness_view, name="draft-readiness"),
    path("api/draft/pick-check/", draft_pick_check, name="draft-pick-check"),

    path("api/elevenlabs/status/", elevenlabs_status, name="elevenlabs-status"),
    path("api/elevenlabs/speak/", elevenlabs_speak, name="elevenlabs-speak"),
    # Health
    path("health", health_view, name="health"),

    # Auth
    path("api/auth/csrf/", csrf_token_view, name="csrf-token"),
    path("api/auth/register/", register_view, name="register"),
    path("api/auth/login/", login_view, name="login"),
    path("api/auth/logout/", logout_view, name="logout"),
    path("api/auth/me/", me_view, name="me"),
    path("api/auth/change-password/", change_password_view, name="change-password"),
    path("api/auth/password-reset/", password_reset_request_view, name="password-reset-request"),
    path("api/auth/password-reset/confirm/", password_reset_confirm_view, name="password-reset-confirm"),

    # Divisions
    path("api/divisions/", divisions_list_create, name="divisions-list-create"),
    path("api/divisions/<uuid:pk>/", division_detail, name="division-detail"),
    path("api/divisions/<uuid:pk>/reset/", division_reset, name="division-reset"),

    # Teams
    path("api/teams/", teams_list_create, name="teams-list-create"),
    path("api/teams/bulk/", teams_bulk_update, name="teams-bulk-update"),
    path("api/teams/<uuid:pk>/", team_detail, name="team-detail"),
    path("api/teams/<uuid:pk>/coach-kids/", team_assign_coach_kid, name="team-assign-coach-kid"),
    path("api/teams/<uuid:pk>/coach-kids/<uuid:player_id>/", team_remove_coach_kid, name="team-remove-coach-kid"),

    # Players
    path("api/players/", players_list_create, name="players-list-create"),
    path("api/players/bulk/", players_bulk_create, name="players-bulk-create"),
    path("api/players/delete_by_division/", players_delete_by_division, name="players-delete-by-division"),
    path("api/players/<uuid:pk>/", player_detail, name="player-detail"),

    # Draft
    path("api/draft/<uuid:division_id>/", draft_retrieve, name="draft-retrieve"),
    path("api/draft/start/", draft_start, name="draft-start"),
    path("api/draft/pick/", draft_pick, name="draft-pick"),
    path("api/draft/undo/", draft_undo, name="draft-undo"),
    path("api/draft/skip/", draft_skip, name="draft-skip"),
    path("api/draft/trade/", draft_trade, name="draft-trade"),

    # League member management
    path("api/leagues/<uuid:league_id>/members/", league_members_list, name="league-members-list"),
    path("api/leagues/<uuid:league_id>/members/<uuid:user_id>/", league_member_remove, name="league-member-remove"),
    path("api/leagues/<uuid:league_id>/members/<uuid:user_id>/role/", league_member_update_role, name="league-member-update-role"),

    # League invitations
    path("api/leagues/<uuid:league_id>/invitations/", league_invitations_list_create, name="league-invitations"),
    path("api/leagues/<uuid:league_id>/invitations/<uuid:pk>/", league_invitation_cancel, name="league-invitation-cancel"),

    # Join link management
    path("api/leagues/<uuid:league_id>/join-link/", join_link_view, name="league-join-link"),

    # Accept invitation
    path("api/invitations/accept/", accept_invitation, name="accept-invitation"),

    # Public join link info
    path("api/leagues/join/<str:token>/", public_join_link_view, name="public-join-link"),

    # Team Builder
    path("api/team-builder/<uuid:division_id>/run/", team_builder_run, name="team-builder-run"),
    path("api/team-builder/<uuid:division_id>/apply/", team_builder_apply, name="team-builder-apply"),
    path("api/team-builder/<uuid:division_id>/update-requests/", team_builder_update_requests, name="team-builder-update-requests"),

    # Evaluation Templates
    path("api/evaluation-templates/", evaluation_templates_list_create, name="evaluation-templates-list-create"),
    path("api/evaluation-templates/<uuid:pk>/", evaluation_template_detail, name="evaluation-template-detail"),

    # Seasons
    path("api/seasons/", seasons_list_create, name="seasons-list-create"),
    path("api/seasons/<uuid:pk>/", season_detail, name="season-detail"),

    # Coach Ratings
    path("api/seasons/<uuid:season_id>/coach-ratings/",
         coach_ratings_list_create, name="coach-ratings-list-create"),
    path("api/coach-ratings/<uuid:pk>/",
         coach_rating_detail, name="coach-rating-detail"),
    path("api/coach-ratings/<uuid:pk>/submit/",
         coach_rating_submit, name="coach-rating-submit"),
    path("api/seasons/<uuid:season_id>/coach-ratings/progress/",
         coach_ratings_progress, name="coach-ratings-progress"),
]
