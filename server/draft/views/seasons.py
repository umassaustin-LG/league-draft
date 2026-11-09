"""
Season views - CRUD for seasons linked to evaluation templates.
"""

from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods

from ..models import EvaluationTemplate, Season
from ..transformers import transform_season
from ..input_validators import validate_season_create_data, validate_season_update_data
from .helpers import (
    json_response,
    parse_json_body,
    require_auth,
    require_organization_admin,
    get_organization_from_request,
)


@require_http_methods(["GET", "POST"])
@csrf_protect
@require_auth
def seasons_list_create(request):
    """List seasons or create a new one."""
    organization = get_organization_from_request(request)
    if not organization:
        return json_response({"error": "No organization context"}, status=400)

    if request.method == "GET":
        seasons = Season.objects.filter(
            organization=organization,
        ).order_by("-year", "-created_at")
        return json_response([transform_season(s) for s in seasons])

    denied = require_organization_admin(request, organization)
    if denied:
        return denied

    # POST - create season
    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    cleaned, errors = validate_season_create_data(data)
    if errors:
        return json_response(errors, status=400)

    # Verify template exists and belongs to same organization
    template_id = cleaned.pop("template_id")
    try:
        template = EvaluationTemplate.objects.get(
            id=template_id,
            organization=organization,
        )
    except EvaluationTemplate.DoesNotExist:
        return json_response(
            {"template_id": ["Template not found or does not belong to this organization"]},
            status=400,
        )

    season = Season.objects.create(
        organization=organization,
        template=template,
        **cleaned,
    )
    return json_response(transform_season(season), status=201)


@require_http_methods(["GET", "PATCH", "DELETE"])
@csrf_protect
@require_auth
def season_detail(request, pk):
    """Retrieve, update, or delete a season."""
    organization = get_organization_from_request(request)
    if not organization:
        return json_response({"error": "No organization context"}, status=400)

    try:
        season = Season.objects.get(
            id=pk,
            organization=organization,
        )
    except Season.DoesNotExist:
        return json_response({"error": "Not found"}, status=404)

    if request.method == "GET":
        return json_response(transform_season(season))

    denied = require_organization_admin(request, season.organization)
    if denied:
        return denied

    if request.method == "DELETE":
        season.delete()
        return json_response({}, status=204)

    # PATCH - update
    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    cleaned, errors = validate_season_update_data(data)
    if errors:
        return json_response(errors, status=400)

    if not cleaned:
        return json_response(transform_season(season))

    # If template_id is being changed, verify new template
    if "template_id" in cleaned:
        template_id = cleaned.pop("template_id")
        try:
            template = EvaluationTemplate.objects.get(
                id=template_id,
                organization=organization,
            )
            season.template = template
        except EvaluationTemplate.DoesNotExist:
            return json_response(
                {"template_id": ["Template not found or does not belong to this organization"]},
                status=400,
            )

    for attr, value in cleaned.items():
        setattr(season, attr, value)
    season.save()

    return json_response(transform_season(season))
