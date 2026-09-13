# Copyright (c) 2023-present Plane Software, Inc. and contributors
# SPDX-License-Identifier: AGPL-3.0-only
# See the LICENSE file for details.

"""Capture work-item changes for Feishu independently of in-app subscriptions."""

import json
import logging
from urllib.parse import quote
from uuid import UUID

from bs4 import BeautifulSoup
from django.db import transaction

from plane.utils.feishu import configured_app_url
from plane.utils.feishu_card_people import NAME_SLOTS_KEY, member_parts, render_parts
from plane.utils.issue_workflow import workflow_default_assignees
from plane.utils.phone import normalize_phone_number

from plane.db.models import (
    Cycle,
    EstimatePoint,
    FeishuIntegration,
    FeishuMessage,
    Issue,
    IssueAssignee,
    Label,
    Module,
    ProjectMember,
    State,
    User,
    WorkspaceMember,
)

logger = logging.getLogger(__name__)

# Aliases used by the app API and external REST API, with one canonical display field.
FIELDS = {
    "name": ("标题", ("name",)),
    "description_html": ("描述", ("description_html",)),
    "state": ("状态", ("state_id", "state")),
    "priority": ("优先级", ("priority",)),
    "assignees": ("负责人", ("assignee_ids", "assignees")),
    "labels": ("标签", ("label_ids", "labels")),
    "start_date": ("开始日期", ("start_date",)),
    "target_date": ("截止日期", ("target_date",)),
    "estimate_point": ("预估", ("estimate_point",)),
    "parent": ("父工作项", ("parent_id", "parent")),
    "type": ("类型", ("type_id", "type")),
    "archived_at": ("归档", ("archived_at",)),
    "state_assignees": ("各状态负责人", ("state_assignees",)),
}
PRIORITIES = {"urgent": "紧急", "high": "高", "medium": "中", "low": "低", "none": "无"}
EVENT_TITLES = {
    "issue.activity.created": "创建了工作项",
    "issue.activity.updated": "修改了工作项",
    "comment.activity.created": "发表了评论",
    "comment.activity.updated": "编辑了评论",
    "comment.activity.deleted": "删除了评论",
    "cycle.activity.created": "调整了工作项周期",
    "cycle.activity.deleted": "移除了工作项周期",
    "module.activity.created": "添加了工作项模块",
    "module.activity.deleted": "移除了工作项模块",
    "link.activity.created": "添加了链接",
    "link.activity.updated": "更新了链接",
    "link.activity.deleted": "删除了链接",
    "attachment.activity.created": "添加了附件",
    "attachment.activity.deleted": "删除了附件",
    "issue_relation.activity.created": "添加了工作项关联",
    "issue_relation.activity.deleted": "删除了工作项关联",
    "intake.activity.created": "更新了收件箱状态",
}


def as_dict(value):
    if isinstance(value, str):
        value = json.loads(value)
    return value if isinstance(value, dict) else {}


def user_ids(value):
    if not isinstance(value, (list, tuple, set)):
        return set()
    result = set()
    for member in value:
        if isinstance(member, dict):
            member = member.get("id")
        try:
            result.add(str(UUID(str(member))))
        except (ValueError, TypeError, AttributeError):
            continue
    return result


def first_value(data, aliases):
    for alias in aliases:
        if alias in data:
            return data[alias]
    return None


def plain_text(value, limit=700):
    if value is None or value == "":
        return "未设置"
    text = str(value)
    if "<" in text and ">" in text:
        soup = BeautifulSoup(text, "html.parser")
        for element in soup(["script", "style"]):
            element.decompose()
        text = soup.get_text(" ", strip=True)
    text = " ".join(text.split())
    return text[:limit] + ("…" if len(text) > limit else "") if text else "未设置"


def normalized(field, value):
    if field in ("assignees", "labels"):
        return sorted(user_ids(value))
    if field == "state_assignees":
        return {str(key): sorted(user_ids(members)) for key, members in as_dict(value).items()}
    if isinstance(value, dict) and "id" in value:
        value = value["id"]
    if value is None or value == "" or value == "None":
        return None
    return str(value)


def display_value(field, value, issue):
    if field == "assignees":
        return render_parts(member_parts(user_ids(value)))
    if field == "labels":
        ids = user_ids(value)
        names = Label.objects.filter(project_id=issue.project_id, pk__in=ids).values_list("name", flat=True)
        return plain_text("、".join(names))
    if field == "priority":
        return PRIORITIES.get(value, plain_text(value))
    if field in ("state", "estimate_point", "parent") and value:
        identifier = value.get("id") if isinstance(value, dict) else value
        try:
            identifier = UUID(str(identifier))
        except (ValueError, TypeError):
            return plain_text(value)
        if field == "state":
            name = (
                State.all_state_objects.filter(project_id=issue.project_id, pk=identifier)
                .values_list("name", flat=True)
                .first()
            )
        elif field == "estimate_point":
            name = (
                EstimatePoint.objects.filter(project_id=issue.project_id, pk=identifier)
                .values_list("value", flat=True)
                .first()
            )
        else:
            parent = Issue.objects.filter(project_id=issue.project_id, pk=identifier).first()
            name = f"{issue.project.identifier}-{parent.sequence_id} {parent.name}" if parent else None
        return plain_text(name or "已移除")
    return plain_text(value)


def plan_change_lines(before, after, issue):
    before, after = as_dict(before), as_dict(after)
    lines = []
    extra_recipients = set()
    for state_id in sorted(set(before) | set(after)):
        if normalized("assignees", before.get(state_id)) == normalized("assignees", after.get(state_id)) and (
            (state_id in before) == (state_id in after)
        ):
            continue
        try:
            state = State.all_state_objects.filter(project_id=issue.project_id, pk=UUID(state_id)).first()
        except (ValueError, TypeError):
            state = None
        default = workflow_default_assignees(issue) if state_id not in before or state_id not in after else []
        old_ids = user_ids(before.get(state_id, default))
        new_ids = user_ids(after.get(state_id, default))
        extra_recipients.update(old_ids | new_ids)
        old_label = member_parts(old_ids)
        new_label = member_parts(new_ids)
        lines.append([f"{plain_text(state.name if state else '已移除状态', 100)}：", *old_label, " → ", *new_label])
    return lines, extra_recipients


def field_changes(before, after, issue):
    lines, extra_recipients = [], set()
    for field, (label, aliases) in FIELDS.items():
        if not any(alias in after for alias in aliases):
            continue
        old_value, new_value = first_value(before, aliases), first_value(after, aliases)
        if normalized(field, old_value) == normalized(field, new_value):
            continue
        if field == "state_assignees":
            plan_lines, members = plan_change_lines(old_value, new_value, issue)
            lines.extend(plan_lines)
            extra_recipients.update(members)
        elif field == "assignees":
            lines.append([f"{label}：", *member_parts(user_ids(old_value)), " → ", *member_parts(user_ids(new_value))])
        else:
            lines.append(
                f"{label}：{display_value(field, old_value, issue)} → {display_value(field, new_value, issue)}"
            )
    if after.get("closed_to"):
        lines.append(f"状态：{display_value('state', after['closed_to'], issue)}")
    return lines, extra_recipients


def issue_url(issue):
    base = configured_app_url()
    slug = quote(issue.workspace.slug, safe="")
    if issue.archived_at:
        return f"{base}/{slug}/projects/{issue.project_id}/archives/issues/{issue.pk}"
    return f"{base}/{slug}/browse/{quote(issue.project.identifier, safe='')}-{issue.sequence_id}/"


def build_card(issue, actor, event_type, lines):
    title = f"工作项更新提醒 - {plain_text(issue.name, 180)}"
    action = EVENT_TITLES[event_type]
    action = action.replace("工作项", "与你有关的工作项", 1) if "工作项" in action else f"在与你有关的工作项中{action}"
    actor_parts = [
        f"工作项：{issue.project.identifier}-{issue.sequence_id}\n",
        {"user_id": str(actor.pk)} if actor else "系统",
        action,
    ]
    summary_parts = []
    for line in lines[:12]:
        if summary_parts:
            summary_parts.append("\n")
        summary_parts.extend(line if isinstance(line, list) else [line])
    if len(lines) > 12:
        summary_parts.append(f"\n另有 {len(lines) - 12} 项变更，请打开详情查看。")
    if not summary_parts:
        summary_parts.append(action)
    return {
        NAME_SLOTS_KEY: [
            {"element_index": 0, "parts": actor_parts},
            {"element_index": 1, "parts": summary_parts},
        ],
        "config": {"wide_screen_mode": True},
        "header": {"template": "blue", "title": {"tag": "plain_text", "content": title}},
        "elements": [
            {
                "tag": "div",
                "text": {
                    "tag": "plain_text",
                    "content": render_parts(actor_parts),
                },
            },
            {"tag": "div", "text": {"tag": "plain_text", "content": render_parts(summary_parts)[:6000]}},
            {
                "tag": "action",
                "actions": [
                    {
                        "tag": "button",
                        "type": "primary",
                        "text": {"tag": "plain_text", "content": "查看工作项"},
                        "url": issue_url(issue),
                    }
                ],
            },
        ],
    }


def related_issue_ids(event_type, issue_id, before, after):
    ids = user_ids([issue_id]) if issue_id else set()
    if event_type == "cycle.activity.created":
        ids.update(user_ids([record.get("issue_id") for record in before.get("updated_cycle_issues", [])]))
        records = before.get("created_cycle_issues", [])
        if isinstance(records, str):
            records = json.loads(records)
        ids.update(user_ids([record.get("fields", {}).get("issue") for record in records]))
    elif event_type == "cycle.activity.deleted":
        ids.update(user_ids(after.get("issues", [])))
    return ids


def activity_lines(event_type, before, after, issue):
    if event_type == "issue.activity.updated":
        return field_changes(before, after, issue)
    if event_type.startswith("comment.activity."):
        if event_type == "comment.activity.updated":
            if "comment_html" not in after or before.get("comment_html") == after["comment_html"]:
                return [], set()
        return [plain_text(after.get("comment_html") or before.get("comment_html"))], set()
    if event_type.startswith("module.activity."):
        name = before.get("module_name")
        if after.get("module_id"):
            name = (
                Module.objects.filter(project_id=issue.project_id, pk=after["module_id"])
                .values_list("name", flat=True)
                .first()
                or name
            )
        return [f"模块：{plain_text(name)}"], set()
    if event_type.startswith("cycle.activity."):
        cycle_id = after.get("cycle_id")
        if not cycle_id:
            for record in before.get("updated_cycle_issues", []):
                if str(record.get("issue_id")) == str(issue.pk):
                    cycle_id = record.get("new_cycle_id")
                    break
        name = (
            Cycle.objects.filter(project_id=issue.project_id, pk=cycle_id).values_list("name", flat=True).first()
            if cycle_id
            else None
        )
        return [f"周期：{plain_text(name or after.get('cycle_name') or '周期关联已更新')}"], set()
    if event_type == "intake.activity.created":
        if before.get("status") == after.get("status"):
            return [], set()
        labels = {-2: "待处理", -1: "已拒绝", 0: "已暂缓", 1: "已接受", 2: "重复"}
        return [
            f"收件箱状态：{labels.get(before.get('status'), '未设置')} → {labels.get(after.get('status'), '已更新')}"
        ], set()
    if event_type == "issue.activity.created":
        return ["工作项已创建，请查看详情。"], set()
    return [EVENT_TITLES[event_type]], set()


@transaction.atomic
def queue_activity_notifications(
    *,
    event_key,
    type,
    requested_data=None,
    current_instance=None,
    issue_id=None,
    actor_id=None,
    project_id=None,
    **kwargs,
):
    """Freeze recipients and content at publication time; never perform an HTTP request here."""
    if type not in EVENT_TITLES:
        return []
    integration = FeishuIntegration.objects.filter(workspace__workspace_project__id=project_id, enabled=True).first()
    if integration is None:
        return []
    before, after = as_dict(current_instance), as_dict(requested_data)
    ids = related_issue_ids(type, issue_id, before, after)
    issues = Issue.objects.filter(
        pk__in=ids, project_id=project_id, workspace_id=integration.workspace_id
    ).select_related("project", "workspace")
    actor = User.objects.filter(pk=actor_id).first() if actor_id else None
    messages = []
    from plane.bgtasks.feishu_task import dispatch_feishu_message

    for issue in issues:
        lines, extra_recipients = activity_lines(type, before, after, issue)
        if not lines:
            continue
        actual = {
            str(member) for member in IssueAssignee.objects.filter(issue=issue).values_list("assignee_id", flat=True)
        }
        old = (
            user_ids(first_value(before, ("assignee_ids", "assignees"))) if type == "issue.activity.updated" else set()
        )
        recipients = actual | old | extra_recipients
        # Internal work-item details and comments must not be sent to guests or former members.
        eligible = ProjectMember.objects.filter(
            project_id=issue.project_id, is_active=True, role__gte=15, member__is_active=True, member_id__in=recipients
        ).values_list("member_id", flat=True)
        recipients = {
            str(member)
            for member in WorkspaceMember.objects.filter(
                workspace_id=integration.workspace_id, is_active=True, member_id__in=eligible
            ).values_list("member_id", flat=True)
        }
        if not recipients:
            continue
        card = build_card(issue, actor, type, lines)
        mobile_numbers = dict(
            (str(user_id), mobile)
            for user_id, mobile in User.objects.filter(pk__in=recipients).values_list("id", "mobile_number")
        )
        for recipient in sorted(recipients):
            raw_mobile = mobile_numbers.get(recipient, "")
            mobile = normalize_phone_number(raw_mobile)
            can_deliver = bool(mobile)
            missing_reason = "phone_invalid" if raw_mobile else "phone_missing"
            message, created = FeishuMessage.objects.get_or_create(
                integration=integration,
                event_key=f"{event_key}:{issue.pk}",
                receiver_id=UUID(recipient),
                defaults={
                    "issue": issue,
                    "card": card,
                    "recipient_open_id": "",
                    "recipient_mobile": mobile,
                    "app_id": integration.app_id,
                    "status": "pending" if can_deliver else "skipped",
                    "last_error": "" if can_deliver else missing_reason,
                },
            )
            if created:
                messages.append(message)
                if can_deliver:
                    transaction.on_commit(lambda message_id=str(message.pk): dispatch_feishu_message(message_id))
    return messages
