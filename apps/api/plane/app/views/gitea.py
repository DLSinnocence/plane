# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only

import hmac
import re
import secrets

from django.db import transaction
from django.shortcuts import get_object_or_404
from rest_framework import serializers
from rest_framework.authentication import BaseAuthentication
from rest_framework.exceptions import AuthenticationFailed, PermissionDenied, Throttled, ValidationError
from rest_framework.permissions import AllowAny, IsAuthenticated
from rest_framework.response import Response
from rest_framework.throttling import SimpleRateThrottle
from rest_framework.views import APIView

from plane.authentication.session import BaseSessionAuthentication
from plane.db.models import (
    GiteaCommit,
    GiteaCommitLink,
    GiteaIntegration,
    Issue,
    ProjectMember,
    Workspace,
    WorkspaceMember,
)
from plane.utils.gitea import (
    GiteaError,
    SHA_PATTERN,
    decrypt,
    encrypt,
    endpoint_url,
    integration_data,
    issue_data,
    issue_for_identifier,
    normalize_url,
    validate_commits,
)


class StrictInput(serializers.Serializer):
    def to_internal_value(self, data):
        if not isinstance(data, dict) or set(data) - set(self.fields):
            raise ValidationError({"non_field_errors": ["Unknown fields or invalid object."]})
        return super().to_internal_value(data)


class ConfigInput(StrictInput):
    enabled = serializers.BooleanField()

    def validate_enabled(self, value):
        if type(self.initial_data["enabled"]) is not bool:
            raise ValidationError("Expected a boolean.")
        return value


class SafeURLField(serializers.CharField):
    def __init__(self, **kwargs):
        super().__init__(max_length=2048, trim_whitespace=False, **kwargs)

    def to_internal_value(self, data):
        if not isinstance(data, str):
            raise ValidationError("Expected a URL string.")
        try:
            return normalize_url(super().to_internal_value(data))
        except GiteaError:
            raise ValidationError(
                "Expected an absolute HTTP(S) URL without credentials or unsafe characters."
            ) from None


class HookInput(StrictInput):
    repository_url = SafeURLField(required=False, allow_blank=True, default="")

    def validate_repository_url(self, value):
        if any(separator in self.initial_data.get("repository_url", "") for separator in ("?", "#")):
            raise ValidationError("Repository URL must not contain a query or fragment.")
        return value


class CommitInput(StrictInput):
    sha = serializers.RegexField("^" + SHA_PATTERN + r"\Z", trim_whitespace=False)
    message = serializers.CharField(max_length=65536, allow_blank=True, trim_whitespace=False)

    def to_internal_value(self, data):
        if isinstance(data, dict):
            for field in ("sha", "message", "author_name", "repository_name", "branch"):
                if field not in data:
                    continue
                if not isinstance(data[field], str):
                    raise ValidationError({field: "Expected a string."})
                try:
                    data[field].encode("utf-8")
                except UnicodeError:
                    raise ValidationError({field: "Expected valid Unicode."}) from None
        return super().to_internal_value(data)

    def validate_sha(self, value):
        return value.lower()

    def validate_message(self, value):
        try:
            if len(value.encode("utf-8")) > 65536:
                raise ValueError
        except (UnicodeError, ValueError):
            raise ValidationError("Message exceeds 64 KiB or contains invalid Unicode.") from None
        return value


class ReportCommitInput(CommitInput):
    url = SafeURLField()
    author_name = serializers.CharField(max_length=255, required=False, allow_blank=True, default="")
    committed_at = serializers.DateTimeField(required=False, allow_null=True, default=None)
    repository_name = serializers.CharField(max_length=255, required=False, allow_blank=True, default="")
    branch = serializers.CharField(max_length=1024, required=False, allow_blank=True, default="")


class ValidationInput(StrictInput):
    commits = CommitInput(many=True, max_length=100, allow_empty=False)

    def validate_commits(self, values):
        if len({c["sha"] for c in values}) != len(values):
            raise ValidationError("Duplicate SHAs are not allowed in a batch.")
        return values


class ReportInput(ValidationInput):
    commits = ReportCommitInput(many=True, max_length=100, allow_empty=False)

    def validate_commits(self, values):
        super().validate_commits(values)
        if len({c["url"] for c in values}) != len(values):
            raise ValidationError("Duplicate URLs are not allowed in a batch.")
        return values


class GiteaThrottle(SimpleRateThrottle):
    scope = "gitea"
    rate = "120/min"

    def get_cache_key(self, request, view):
        integration = getattr(request, "gitea_integration", None)
        ident = str(integration.workspace_id) if integration else self.get_ident(request)
        return self.cache_format % {"scope": self.scope, "ident": ident}


class GiteaAnonymousThrottle(SimpleRateThrottle):
    scope = "gitea_public_ip"
    rate = "300/min"

    def get_cache_key(self, request, view):
        return self.cache_format % {"scope": self.scope, "ident": self.get_ident(request)}


class GiteaAPIView(APIView):
    def initial(self, request, *args, **kwargs):
        if request.path.startswith("/api/integrations/gitea/"):
            throttle = GiteaAnonymousThrottle()
            if not throttle.allow_request(request, self):
                raise Throttled(wait=throttle.wait())
        super().initial(request, *args, **kwargs)

    def finalize_response(self, request, response, *args, **kwargs):
        response = super().finalize_response(request, response, *args, **kwargs)
        response["Cache-Control"] = "no-store"
        return response

    def handle_exception(self, exc):
        if isinstance(exc, GiteaError):
            return Response({"error": exc.reason}, status=400)
        return super().handle_exception(exc)


class GiteaAdminAPIView(GiteaAPIView):
    authentication_classes = [BaseSessionAuthentication]
    permission_classes = [IsAuthenticated]

    def workspace(self, request, slug):
        workspace = get_object_or_404(Workspace, slug=slug, deleted_at__isnull=True)
        if (
            not request.user.is_active
            or not WorkspaceMember.objects.filter(
                workspace=workspace, member=request.user, role=20, is_active=True
            ).exists()
        ):
            raise PermissionDenied("Only active workspace administrators can manage Gitea.")
        return workspace


class GiteaIntegrationEndpoint(GiteaAdminAPIView):
    def get(self, request, slug):
        workspace = self.workspace(request, slug)
        return Response(integration_data(workspace, GiteaIntegration.objects.filter(workspace=workspace).first()))

    def patch(self, request, slug):
        workspace = self.workspace(request, slug)
        data = ConfigInput(data=request.data)
        data.is_valid(raise_exception=True)
        with transaction.atomic():
            Workspace.objects.select_for_update().get(pk=workspace.pk)
            integration, _ = GiteaIntegration.all_objects.get_or_create(workspace=workspace)
            integration.enabled = data.validated_data["enabled"]
            if integration.enabled and not integration.secret:
                integration.secret = encrypt(secrets.token_urlsafe(48))
            integration.deleted_at = None
            integration.save()
            result = integration_data(workspace, integration)
        return Response(result)


class GiteaRotateTokenEndpoint(GiteaAdminAPIView):
    def post(self, request, slug):
        workspace = self.workspace(request, slug)
        data = StrictInput(data=request.data)
        data.is_valid(raise_exception=True)
        with transaction.atomic():
            Workspace.objects.select_for_update().get(pk=workspace.pk)
            integration, _ = GiteaIntegration.all_objects.get_or_create(workspace=workspace)
            integration.secret = encrypt(secrets.token_urlsafe(48))
            integration.deleted_at = None
            integration.save()
            result = integration_data(workspace, integration)
        return Response(result)


class GiteaHookEndpoint(GiteaAdminAPIView):
    def post(self, request, slug):
        from plane.utils.gitea_hook import generate_hooks

        workspace = self.workspace(request, slug)
        data = HookInput(data=request.data)
        data.is_valid(raise_exception=True)
        integration = GiteaIntegration.objects.filter(workspace=workspace, enabled=True).first()
        if not integration or not integration.secret:
            raise ValidationError({"error": "integration_disabled"})
        return Response(
            generate_hooks(
                endpoint_url(workspace, "validate"),
                endpoint_url(workspace, "commits"),
                decrypt(integration.secret),
                data.validated_data["repository_url"],
            )
        )


class WorkspaceBearerAuthentication(BaseAuthentication):
    def authenticate_header(self, request):
        return "Bearer"

    def authenticate(self, request):
        slug = request.parser_context["kwargs"]["slug"]
        integration = (
            GiteaIntegration.objects.select_related("workspace")
            .filter(
                workspace__slug=slug,
                workspace__deleted_at__isnull=True,
                enabled=True,
            )
            .first()
        )
        authorization = request.headers.get("Authorization", "")
        try:
            valid = (
                integration is not None
                and authorization.startswith("Bearer ")
                and len(authorization) < 1024
                and hmac.compare_digest(authorization[7:].encode(), decrypt(integration.secret).encode())
            )
        except (GiteaError, TypeError, UnicodeError):
            valid = False
        if not valid:
            raise AuthenticationFailed("Invalid workspace credentials or integration disabled.")
        request.gitea_integration = integration
        return None


class GiteaBearerAPIView(GiteaAPIView):
    authentication_classes = [WorkspaceBearerAuthentication]
    permission_classes = [AllowAny]
    throttle_classes = [GiteaThrottle]

    def handle_exception(self, exc):
        if isinstance(exc, ValidationError):
            return Response({"valid": False, "errors": exc.detail}, status=400)
        return super().handle_exception(exc)

    def commit_input(self, request, serializer):
        if len(request.body) > 8 * 1024 * 1024:
            raise ValidationError({"commits": "Payload exceeds 8 MiB."})
        data = serializer(data=request.data)
        data.is_valid(raise_exception=True)
        return data.validated_data["commits"]


class GiteaValidateEndpoint(GiteaBearerAPIView):
    def post(self, request, slug):
        commits = self.commit_input(request, ValidationInput)
        return Response(validate_commits(request.gitea_integration.workspace, commits))


class GiteaCommitsEndpoint(GiteaBearerAPIView):
    """Trust the dedicated token's successful-push report; no remote push verification."""

    def post(self, request, slug):
        commits = self.commit_input(request, ReportInput)
        workspace = request.gitea_integration.workspace
        with transaction.atomic():
            # Serialize reports and config/token changes, including absent commit rows.
            Workspace.objects.select_for_update().get(pk=workspace.pk)
            current = GiteaIntegration.objects.filter(pk=request.gitea_integration.pk).first()
            if current is None or not current.enabled or current.secret != request.gitea_integration.secret:
                raise AuthenticationFailed("Workspace credentials changed.")
            validation = validate_commits(workspace, commits)
            if not validation["valid"]:
                return Response(validation, status=400)
            existing = {
                c.url: c
                for c in GiteaCommit.all_objects.filter(workspace=workspace, url__in=[c["url"] for c in commits])
            }
            for payload, row in zip(commits, validation["results"]):
                stored = existing.get(payload["url"])
                if stored and (stored.sha != payload["sha"] or stored.message != payload["message"]):
                    row["valid"] = False
                    row["error"] = {
                        "code": "commit_conflict",
                        "message": "This URL already has a different SHA or message.",
                    }
                    validation["valid"] = False
            if not validation["valid"]:
                return Response(validation, status=400)
            linked_count = 0
            for payload, row in zip(commits, validation["results"]):
                commit, _ = GiteaCommit.all_objects.update_or_create(
                    workspace=workspace,
                    url=payload["url"],
                    defaults={
                        **payload,
                        "title": payload["message"].split("\n", 1)[0].rstrip("\r"),
                        "deleted_at": None,
                    },
                )
                GiteaCommitLink.all_objects.update_or_create(
                    commit=commit,
                    issue_id=row["work_item"]["id"],
                    defaults={"deleted_at": None},
                )
                linked_count += 1
        return Response({**validation, "linked_count": linked_count})


class GiteaWorkItemEndpoint(GiteaBearerAPIView):
    def get(self, request, slug, identifier):
        workspace = request.gitea_integration.workspace
        issue = issue_for_identifier(workspace, identifier)
        if issue is None:
            return Response({"error": "work_item_not_found"}, status=404)
        return Response(issue_data(workspace, issue))


class GiteaCommitWorkItemsEndpoint(GiteaBearerAPIView):
    def get(self, request, slug, sha):
        workspace = request.gitea_integration.workspace
        if not re.fullmatch(SHA_PATTERN, sha):
            raise ValidationError({"error": "invalid_sha"})
        filters = {}
        if "url" in request.query_params:
            filters["gitea_commit_links__commit__url"] = normalize_url(request.query_params["url"])
        issues = (
            Issue.objects.select_related("project")
            .filter(
                gitea_commit_links__commit__workspace=workspace,
                gitea_commit_links__commit__sha=sha.lower(),
                gitea_commit_links__deleted_at__isnull=True,
                gitea_commit_links__commit__deleted_at__isnull=True,
                project__workspace=workspace,
                project__deleted_at__isnull=True,
                workspace=workspace,
                is_draft=False,
                **filters,
            )
            .distinct()
            .order_by("id")
        )
        return Response({"results": [issue_data(workspace, issue) for issue in issues]})


class GiteaIssueCommitsEndpoint(GiteaAPIView):
    authentication_classes = [BaseSessionAuthentication]
    permission_classes = [IsAuthenticated]

    def get(self, request, slug, project_id, issue_id):
        workspace = get_object_or_404(Workspace, slug=slug, deleted_at__isnull=True)
        if (
            not request.user.is_active
            or not WorkspaceMember.objects.filter(workspace=workspace, member=request.user, is_active=True).exists()
            or not ProjectMember.objects.filter(
                workspace=workspace,
                project_id=project_id,
                member=request.user,
                is_active=True,
                project__workspace=workspace,
                project__deleted_at__isnull=True,
            ).exists()
        ):
            raise PermissionDenied("Active project membership is required.")
        issue = get_object_or_404(Issue, pk=issue_id, project_id=project_id, workspace=workspace, is_draft=False)
        try:
            page = int(request.query_params.get("page", "1"))
            if page < 1 or page > 1000000:
                raise ValueError
        except ValueError:
            raise ValidationError({"error": "invalid_page"}) from None
        commits = GiteaCommit.objects.filter(
            links__issue=issue,
            links__deleted_at__isnull=True,
            workspace=workspace,
        ).order_by("-created_at", "-id")
        count = commits.count()
        return Response(
            {
                "results": [
                    {
                        "id": str(c.id),
                        "sha": c.sha,
                        "short_sha": c.sha[:7],
                        "title": c.title,
                        "author_name": c.author_name,
                        "committed_at": c.committed_at,
                        "url": c.url,
                        "repository_name": c.repository_name,
                        "branch": c.branch,
                    }
                    for c in commits[(page - 1) * 25 : page * 25]
                ],
                "count": count,
                "next_page": page + 1 if page * 25 < count else None,
            }
        )
