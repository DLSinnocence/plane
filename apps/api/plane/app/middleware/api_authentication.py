# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

# Keep both API-key entry points under the same expiry and temporary-token scope
# policy. Session-authenticated application routes continue using their own auth.
from plane.api.middleware.api_authentication import APIKeyAuthentication as APIKeyAuthentication
