# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

import logging
from uuid import uuid4

from celery import Task

logger = logging.getLogger(__name__)


class IssueActivityTask(Task):
    """Capture bot delivery records at the shared activity publication boundary."""

    def apply_async(self, args=None, kwargs=None, task_id=None, **options):
        task_id = task_id or str(uuid4())
        names = (
            "type",
            "requested_data",
            "current_instance",
            "issue_id",
            "actor_id",
            "project_id",
            "epoch",
            "subscriber",
            "notification",
            "origin",
            "intake",
        )
        event = dict(zip(names, args or ()))
        event.update(kwargs or {})
        try:
            from plane.utils.feishu_notifications import queue_activity_notifications

            queue_activity_notifications(event_key=task_id, **event)
        except Exception:
            # Notification integrations must never prevent the work item from saving.
            # Do not log request payloads, private comments, or credentials.
            logger.error("Could not record Feishu notifications for work-item activity %s", task_id)
        return super().apply_async(args=args, kwargs=kwargs, task_id=task_id, **options)
