# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

from plane.authentication.views.app.meowalive import MeowAliveCallbackEndpoint, MeowAliveOauthInitiateEndpoint


class MeowAliveOauthInitiateSpaceEndpoint(MeowAliveOauthInitiateEndpoint):
    is_space = True


class MeowAliveCallbackSpaceEndpoint(MeowAliveCallbackEndpoint):
    is_space = True
