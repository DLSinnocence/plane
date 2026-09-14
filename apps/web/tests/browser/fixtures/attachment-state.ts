/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { AxiosError, AxiosHeaders } from "axios";
import { makeAutoObservable } from "mobx";
import type { TAttachmentTemplate, TIssueAttachment, TIssueAttachmentSlot } from "@plane/types";

const httpError = (status: number, data: unknown) =>
  new AxiosError(`Request failed with status code ${status}`, "ERR_BAD_RESPONSE", undefined, undefined, {
    status,
    statusText: "Rejected",
    headers: {},
    config: { headers: new AxiosHeaders() },
    data,
  });
const params = new URLSearchParams(window.location.search);
const file = (id: string, name: string): TIssueAttachment => ({
  id,
  attributes: { name, size: 4 },
  asset_url: `/files/${name}`,
  issue_id: "issue",
  created_by: params.has("own-file") ? "developer" : "",
  updated_by: "",
  updated_at: "2026-01-01",
});
class AttachmentFixtureState {
  slots: TIssueAttachmentSlot[] = params.has("empty")
    ? []
    : [
        {
          id: "design",
          name: params.has("long-names") ? "Design requirements and supporting evidence for the release" : "Design",
          sort_order: 0,
          attachment: params.has("empty-slot")
            ? null
            : file(
                "old",
                params.has("long-names")
                  ? "release-supporting-evidence-and-complete-design-requirements.txt"
                  : "old.txt"
              ),
        },
      ];
  files: TIssueAttachment[] = params.has("empty") ? [] : [file("old", "old.txt")];
  templates: TAttachmentTemplate[] = [
    {
      id: "review",
      name: "Review template",
      slots: ["design", "Approval"],
      created_by: null,
      updated_at: "2026-01-01",
    },
  ];
  calls: string[] = [];
  openWidgets: string[] = params.has("collapsed") ? [] : ["attachments"];
  toggleOpenWidget(widget: string) {
    this.openWidgets = this.openWidgets.includes(widget)
      ? this.openWidgets.filter((item) => item !== widget)
      : [...this.openWidgets, widget];
  }
  serial = 0;
  constructor() {
    makeAutoObservable(this, {}, { autoBind: true });
  }
  getAttachmentSlotsByIssueId() {
    return this.slots;
  }
  getAttachmentsByIssueId() {
    return this.files.map((item) => item.id);
  }
  getAttachmentById(id: string) {
    return this.files.find((item) => item.id === id);
  }
  async fetchAttachmentSlots() {
    this.calls.push("fetchSlots");
    if (params.has("fetch-forbidden")) throw httpError(403, { detail: "Slot access denied by project policy" });
    return this.slots;
  }
  async createAttachmentSlot(_workspace: string, _project: string, _issue: string, name: string) {
    this.calls.push("createSlot");
    if (params.has("create-fail")) throw httpError(503, { detail: "Attachment creation unavailable" });
    if (this.slots.some((slot) => slot.name.toLowerCase() === name.toLowerCase()))
      throw httpError(400, { name: ["A slot with this name already exists."] });
    const slot = { id: `slot-${++this.serial}`, name, sort_order: this.slots.length, attachment: null };
    this.slots.push(slot);
    return slot;
  }
  async updateAttachmentSlot(_workspace: string, _project: string, _issue: string, id: string, name: string) {
    this.calls.push("renameSlot");
    const slot = this.slots.find((item) => item.id === id)!;
    if (name === "reject") throw httpError(503, { detail: "Rejected rename" });
    if (this.slots.some((item) => item.id !== id && item.name.toLowerCase() === name.toLowerCase()))
      throw httpError(400, { name: ["A slot with this name already exists."] });
    slot.name = name;
    return slot;
  }
  async removeAttachmentSlot(_workspace: string, _project: string, _issue: string, id: string) {
    this.calls.push("deleteSlot");
    this.slots = this.slots.filter((item) => item.id !== id);
  }
  async removeAttachment(_workspace: string, _project: string, _issue: string, id: string) {
    this.calls.push("deleteFile");
    this.files = this.files.filter((item) => item.id !== id);
    for (const slot of this.slots) if (slot.attachment?.id === id) slot.attachment = null;
  }
  getAttachmentsUploadStatusByIssueId() {
    return [];
  }
  async createAttachment(_workspace: string, _project: string, _issue: string, upload: File, slotId?: string) {
    return this.upload(upload, slotId);
  }
  async upload(upload: File, slotId?: string) {
    this.calls.push(`upload:${upload.name}:${slotId ?? "ordinary"}`);
    if (upload.name === "forbidden.txt") throw httpError(403, { detail: "Uploads denied by project policy" });
    if (upload.name === "provider.txt")
      throw httpError(
        502,
        "<Error><Code>StorageUnavailable</Code><Message>Bucket temporarily unavailable</Message><RequestId>private-request-id</RequestId></Error>"
      );
    if (upload.name === "fail.txt") throw new Error("Upload rejected");
    const uploaded = file(`file-${++this.serial}`, upload.name);
    uploaded.attributes.size = upload.size;
    this.files.push(uploaded);
    const slot = this.slots.find((item) => item.id === slotId);
    if (slot) slot.attachment = uploaded;
  }
  async applyAttachmentTemplate(_workspace: string, _project: string, _issue: string, id: string) {
    this.calls.push("applyTemplate");
    const template = this.templates.find((item) => item.id === id)!;
    for (const name of template.slots)
      if (!this.slots.some((slot) => slot.name.toLowerCase() === name.toLowerCase()))
        this.slots.push({ id: `slot-${++this.serial}`, name, sort_order: this.slots.length, attachment: null });
    return this.slots;
  }
}
export const attachmentFixture = new AttachmentFixtureState();
export const useIssueDetail = () => ({
  openWidgets: attachmentFixture.openWidgets,
  toggleOpenWidget: attachmentFixture.toggleOpenWidget,
  issue: {
    getIssueById: () => ({ id: "issue", project_id: "project", attachment_count: attachmentFixture.files.length }),
  },
  attachment: attachmentFixture,
  attachmentDeleteModalId: null,
  toggleDeleteAttachmentModal: () => {},
  fetchActivities: async () => {},
  setLastWidgetAction: () => {},
});
export const useFileSize = () => ({ maxFileSize: params.has("limit-5mb") ? 5 * 1024 ** 2 : 1024 ** 3 });
export const usePlatformOS = () => ({ isMobile: false });
export class AttachmentTemplateService {
  async fetchTemplates() {
    attachmentFixture.calls.push("fetchTemplates");
    return [...attachmentFixture.templates];
  }
  async createTemplate(_workspace: string, data: { name: string; slots: string[] }) {
    attachmentFixture.calls.push("createTemplate");
    const template = {
      ...data,
      id: `template-${++attachmentFixture.serial}`,
      created_by: null,
      updated_at: "2026-01-01",
    };
    attachmentFixture.templates.push(template);
    return template;
  }
  async updateTemplate(_workspace: string, id: string, data: { name: string; slots: string[] }) {
    attachmentFixture.calls.push("updateTemplate");
    const template = attachmentFixture.templates.find((item) => item.id === id)!;
    Object.assign(template, data);
    return template;
  }
  async deleteTemplate(_workspace: string, id: string) {
    attachmentFixture.calls.push("deleteTemplate");
    attachmentFixture.templates = attachmentFixture.templates.filter((item) => item.id !== id);
  }
}
