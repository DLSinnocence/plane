# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import base64
import json
from pathlib import Path
import runpy
from types import SimpleNamespace
from unittest.mock import Mock

import pytest
from celery import Task
from django.core.cache import cache
from django.core.exceptions import ValidationError
from django.utils import timezone

from plane.db.models import FileAsset, Issue, Project, ProjectMember, State
from plane.db.models.asset import file_size as validate_asset_size
from plane.db.models.issue import file_size as validate_attachment_size
from plane.license.models import Instance
import plane.settings.common as common_settings

pytestmark = pytest.mark.unit
GIB = 1024**3


def test_default_file_limit_is_one_gib_without_expanding_api_body_buffer(monkeypatch):
    monkeypatch.delenv("FILE_SIZE_LIMIT", raising=False)
    monkeypatch.delenv("DATA_UPLOAD_MAX_MEMORY_SIZE", raising=False)
    defaults = runpy.run_path(str(Path(common_settings.__file__)))
    assert defaults["FILE_SIZE_LIMIT"] == GIB
    assert defaults["DATA_UPLOAD_MAX_MEMORY_SIZE"] == 10 * 1024 * 1024


@pytest.mark.parametrize("limit", [GIB, 128 * 1024 * 1024])
@pytest.mark.parametrize("validator", [validate_asset_size, validate_attachment_size])
def test_file_validators_allow_the_limit_and_report_the_configured_limit(settings, limit, validator):
    settings.FILE_SIZE_LIMIT = limit
    validator(SimpleNamespace(size=limit))
    with pytest.raises(ValidationError) as error:
        validator(SimpleNamespace(size=limit + 1))
    assert f"{limit / 1024 / 1024:g} MB" in str(error.value)


@pytest.mark.django_db
@pytest.mark.parametrize("limit", [GIB, 128 * 1024 * 1024])
def test_instance_exposes_the_effective_backend_file_limit(api_client, settings, limit):
    settings.FILE_SIZE_LIMIT = limit
    settings.CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
    cache.clear()
    Instance.objects.create(
        instance_name="Upload limit test",
        instance_id="upload-limit-test",
        current_version="test",
        last_checked_at=timezone.now(),
    )
    response = api_client.get("/api/instances/")
    assert response.status_code == 200, response.data
    assert response.data["config"]["file_size_limit"] == limit


@pytest.mark.django_db
def test_cached_instance_does_not_keep_the_previous_upload_limit(api_client, settings):
    settings.FILE_SIZE_LIMIT = GIB
    settings.CACHES = {"default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}}
    cache.clear()
    cache.set(
        "/api/instances/",
        {"data": {"config": {"file_size_limit": 5 * 1024 * 1024}, "instance": {"id": "cached"}}, "status": 200},
        7200,
    )
    response = api_client.get("/api/instances/")
    assert response.status_code == 200
    assert response.data["config"]["file_size_limit"] == GIB
    assert response.data["instance"]["id"] == "cached"


@pytest.mark.django_db
@pytest.mark.parametrize("size", [39 * 1024, 6 * 1024 * 1024, GIB - 1, GIB, GIB + 1])
def test_attachment_upload_policy_allows_large_files_but_caps_each_file(
    workspace, create_user, session_client, settings, monkeypatch, size
):
    settings.FILE_SIZE_LIMIT = GIB
    monkeypatch.setattr(Task, "apply_async", Mock())
    for key, value in {
        "USE_MINIO": "0",
        "AWS_ACCESS_KEY_ID": "upload-test-key",
        "AWS_SECRET_ACCESS_KEY": "upload-test-secret",
        "AWS_S3_BUCKET_NAME": "uploads",
        "AWS_REGION": "us-east-1",
        "AWS_S3_ENDPOINT_URL": "https://storage.example.test",
    }.items():
        monkeypatch.setenv(key, value)
    project = Project.objects.create(workspace=workspace, name="Upload limits", identifier="UPLOAD")
    ProjectMember.objects.create(project=project, member=create_user, role=20)
    state = State.objects.create(project=project, name="Todo", group="unstarted", default=True)
    issue = Issue.objects.create(project=project, state=state, name="Upload large ZIP")
    response = session_client.post(
        f"/api/assets/v2/workspaces/{workspace.slug}/projects/{project.pk}/issues/{issue.pk}/attachments/",
        {"name": "archive.zip", "type": "application/zip", "size": size},
        format="json",
    )
    assert response.status_code == 200, response.data
    policy = json.loads(base64.b64decode(response.data["upload_data"]["fields"]["policy"]))
    expected_limit = min(size, GIB)
    assert ["content-length-range", 1, expected_limit] in policy["conditions"]
    assert {"Content-Type": "application/zip"} in policy["conditions"]
    asset = FileAsset.objects.get(pk=response.data["asset_id"])
    assert asset.size == expected_limit
    assert asset.attributes["size"] == expected_limit
    assert asset.is_uploaded is False
