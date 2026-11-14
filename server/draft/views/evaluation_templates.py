"""
Evaluation template views - CRUD with copy-on-write versioning.
"""

from django.views.decorators.csrf import csrf_protect
from django.views.decorators.http import require_http_methods

from ..models import EvaluationTemplate
from ..transformers import transform_evaluation_template
from ..input_validators import validate_template_create_data, validate_template_update_data
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
def evaluation_templates_list_create(request):
    """List templates or create a new one."""
    organization = get_organization_from_request(request)
    if not organization:
        return json_response({"error": "No organization context"}, status=400)

    if request.method == "GET":
        templates = EvaluationTemplate.objects.filter(
            organization=organization,
            is_active=True,
        ).order_by("-updated_at")
        return json_response([transform_evaluation_template(t) for t in templates])

    denied = require_organization_admin(request, organization)
    if denied:
        return denied

    # POST - create template
    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    cleaned, errors = validate_template_create_data(data)
    if errors:
        return json_response(errors, status=400)

    template = EvaluationTemplate.objects.create(
        organization=organization,
        created_by=request.user,
        **cleaned,
    )
    return json_response(transform_evaluation_template(template), status=201)


@require_http_methods(["GET", "PATCH", "DELETE"])
@csrf_protect
@require_auth
def evaluation_template_detail(request, pk):
    """Retrieve, update, or delete a template."""
    organization = get_organization_from_request(request)
    if not organization:
        return json_response({"error": "No organization context"}, status=400)

    try:
        template = EvaluationTemplate.objects.get(
            id=pk,
            organization=organization,
        )
    except EvaluationTemplate.DoesNotExist:
        return json_response({"error": "Not found"}, status=404)

    if request.method == "GET":
        return json_response(transform_evaluation_template(template))

    denied = require_organization_admin(request, template.organization)
    if denied:
        return denied

    if request.method == "DELETE":
        if template.is_locked:
            return json_response(
                {"error": "Cannot delete a template that has been used for scoring. Create a new version instead."},
                status=400,
            )
        template.is_active = False
        template.save(update_fields=["is_active", "updated_at"])
        return json_response({}, status=204)

    # PATCH - update (with copy-on-write versioning for locked templates)
    data, parse_error = parse_json_body(request)
    if parse_error:
        return json_response({"error": parse_error}, status=400)

    cleaned, errors = validate_template_update_data(data)
    if errors:
        return json_response(errors, status=400)

    if not cleaned:
        # No valid fields to update
        return json_response(transform_evaluation_template(template))

    if template.is_locked:
        # Copy-on-write: create a new version
        new_template = EvaluationTemplate.objects.create(
            organization=template.organization,
            name=cleaned.get("name", template.name),
            description=cleaned.get("description", template.description),
            version=template.version + 1,
            parent_template=template,
            stations=cleaned.get("stations", template.stations),
            coach_categories=cleaned.get("coach_categories", template.coach_categories),
            blend_weights=cleaned.get("blend_weights", template.blend_weights),
            is_active=True,
            is_locked=False,
            created_by=request.user,
        )
        # Deactivate old version from listing
        template.is_active = False
        template.save(update_fields=["is_active", "updated_at"])

        return json_response(transform_evaluation_template(new_template), status=201)

    # Not locked - update in place
    for attr, value in cleaned.items():
        setattr(template, attr, value)
    template.save()

    return json_response(transform_evaluation_template(template))
