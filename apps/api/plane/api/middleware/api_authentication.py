# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from django.utils import timezone
from django.db.models import Q
from rest_framework import authentication
from rest_framework.exceptions import AuthenticationFailed

from plane.db.models import APIToken
from plane.utils.ai import enforce_agent_token_scope


class APIKeyAuthentication(authentication.BaseAuthentication):
    """Authentication with an API key, including scoped temporary AI tokens."""

    www_authenticate_realm = "api"
    media_type = "application/json"
    auth_header_name = "X-Api-Key"

    def get_api_token(self, request):
        return request.headers.get(self.auth_header_name)

    def validate_api_token(self, token, request=None):
        try:
            api_token = APIToken.objects.select_related("workspace").get(
                Q(Q(expired_at__gt=timezone.now()) | Q(expired_at__isnull=True)),
                token=token,
                is_active=True,
                user__is_active=True,
            )
        except APIToken.DoesNotExist:
            raise AuthenticationFailed("Given API token is not valid")

        if request is not None:
            enforce_agent_token_scope(api_token, request)
        api_token.last_used = timezone.now()
        api_token.save(update_fields=["last_used"])
        return (api_token.user, api_token.token)

    def authenticate(self, request):
        token = self.get_api_token(request=request)
        if not token:
            return None
        return self.validate_api_token(token, request=request)
