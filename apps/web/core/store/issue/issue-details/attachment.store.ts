/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { uniq, pull, set, debounce, update, concat, sortBy } from "lodash-es";
import { action, computed, makeObservable, observable, runInAction } from "mobx";
import { computedFn } from "mobx-utils";
import { v4 as uuidv4 } from "uuid";
// types
import type {
  TIssueAttachment,
  TIssueAttachmentMap,
  TIssueAttachmentIdMap,
  TIssueAttachmentSlot,
  TIssueServiceType,
} from "@plane/types";
// services
import { IssueAttachmentService } from "@/services/issue";
import { AttachmentTemplateService } from "@/services/issue/attachment-template.service";
import type { IIssueRootStore } from "../root.store";
import type { IIssueDetail } from "./root.store";

export type TAttachmentUploadStatus = {
  id: string;
  name: string;
  progress: number;
  size: number;
  type: string;
};

export interface IIssueAttachmentStoreActions {
  // actions
  addAttachments: (issueId: string, attachments: TIssueAttachment[]) => void;
  fetchAttachments: (workspaceSlug: string, projectId: string, issueId: string) => Promise<TIssueAttachment[]>;
  createAttachment: (
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    file: File,
    slotId?: string
  ) => Promise<TIssueAttachment>;
  removeAttachment: (
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    attachmentId: string
  ) => Promise<TIssueAttachment>;
}

export interface IIssueAttachmentStore extends IIssueAttachmentStoreActions {
  fetchAttachmentSlots: (workspaceSlug: string, projectId: string, issueId: string) => Promise<TIssueAttachmentSlot[]>;
  createAttachmentSlot: (
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    name: string
  ) => Promise<TIssueAttachmentSlot>;
  updateAttachmentSlot: (
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    slotId: string,
    name: string
  ) => Promise<TIssueAttachmentSlot>;
  removeAttachmentSlot: (workspaceSlug: string, projectId: string, issueId: string, slotId: string) => Promise<void>;
  applyAttachmentTemplate: (
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    templateId: string
  ) => Promise<TIssueAttachmentSlot[]>;
  // observables
  attachments: TIssueAttachmentIdMap;
  attachmentMap: TIssueAttachmentMap;
  attachmentSlots: Record<string, TIssueAttachmentSlot[]>;
  attachmentsUploadStatusMap: Record<string, Record<string, TAttachmentUploadStatus>>;
  // computed
  issueAttachments: string[] | undefined;
  // helper methods
  getAttachmentsUploadStatusByIssueId: (issueId: string) => TAttachmentUploadStatus[] | undefined;
  getAttachmentsByIssueId: (issueId: string) => string[] | undefined;
  getAttachmentSlotsByIssueId: (issueId: string) => TIssueAttachmentSlot[] | undefined;
  getAttachmentById: (attachmentId: string) => TIssueAttachment | undefined;
  getAttachmentsCountByIssueId: (issueId: string) => number;
}

export class IssueAttachmentStore implements IIssueAttachmentStore {
  // observables
  attachments: TIssueAttachmentIdMap = {};
  attachmentMap: TIssueAttachmentMap = {};
  attachmentSlots: Record<string, TIssueAttachmentSlot[]> = {};
  private slotRequestVersions: Record<string, number> = {};
  attachmentsUploadStatusMap: Record<string, Record<string, TAttachmentUploadStatus>> = {};
  // root store
  rootIssueStore: IIssueRootStore;
  rootIssueDetailStore: IIssueDetail;
  // services
  issueAttachmentService;
  private attachmentTemplateService = new AttachmentTemplateService();

  constructor(rootStore: IIssueRootStore, serviceType: TIssueServiceType) {
    makeObservable(this, {
      // observables
      attachments: observable,
      attachmentMap: observable,
      attachmentSlots: observable,
      attachmentsUploadStatusMap: observable,
      // computed
      issueAttachments: computed,
      // actions
      addAttachments: action.bound,
      fetchAttachments: action,
      createAttachment: action,
      removeAttachment: action,
    });
    // root store
    this.rootIssueStore = rootStore;
    this.rootIssueDetailStore = rootStore.issueDetail;
    // services
    this.issueAttachmentService = new IssueAttachmentService(serviceType);
  }

  // computed
  get issueAttachments() {
    const issueId = this.rootIssueDetailStore.peekIssue?.issueId;
    if (!issueId) return undefined;
    return this.attachments[issueId] ?? undefined;
  }

  // helper methods
  getAttachmentsUploadStatusByIssueId = computedFn((issueId: string) => {
    if (!issueId) return undefined;
    const attachmentsUploadStatus = Object.values(this.attachmentsUploadStatusMap[issueId] ?? {});
    return attachmentsUploadStatus ?? undefined;
  });

  getAttachmentsByIssueId = (issueId: string) => {
    if (!issueId) return undefined;
    return this.attachments[issueId] ?? undefined;
  };

  getAttachmentSlotsByIssueId = (issueId: string) => this.attachmentSlots[issueId];

  private nextSlotRequest(issueId: string) {
    const version = (this.slotRequestVersions[issueId] ?? 0) + 1;
    this.slotRequestVersions[issueId] = version;
    return version;
  }

  private setAttachmentSlots(issueId: string, slots: TIssueAttachmentSlot[]) {
    this.nextSlotRequest(issueId);
    runInAction(() => {
      const currentAttachmentIds = new Set(slots.map((slot) => slot.attachment?.id).filter(Boolean));
      for (const previous of this.attachmentSlots[issueId] ?? []) {
        if (previous.attachment && !currentAttachmentIds.has(previous.attachment.id)) {
          const attachment = this.attachmentMap[previous.attachment.id];
          if (attachment) attachment.attachment_slot_id = null;
        }
      }
      this.attachmentSlots[issueId] = sortBy(slots, "sort_order");
      this.addAttachments(
        issueId,
        slots.flatMap((slot) => (slot.attachment ? [slot.attachment] : []))
      );
    });
  }

  fetchAttachmentSlots = async (workspaceSlug: string, projectId: string, issueId: string) => {
    const version = this.nextSlotRequest(issueId);
    const slots = await this.attachmentTemplateService.fetchSlots(workspaceSlug, projectId, issueId);
    if (this.slotRequestVersions[issueId] === version) this.setAttachmentSlots(issueId, slots);
    return slots;
  };

  createAttachmentSlot = async (workspaceSlug: string, projectId: string, issueId: string, name: string) => {
    this.nextSlotRequest(issueId);
    const slot = await this.attachmentTemplateService.createSlot(workspaceSlug, projectId, issueId, name);
    this.setAttachmentSlots(issueId, [
      ...(this.attachmentSlots[issueId] ?? []).filter((current) => current.id !== slot.id),
      slot,
    ]);
    return slot;
  };

  updateAttachmentSlot = async (
    workspaceSlug: string,
    projectId: string,
    issueId: string,
    slotId: string,
    name: string
  ) => {
    this.nextSlotRequest(issueId);
    const slot = await this.attachmentTemplateService.updateSlot(workspaceSlug, projectId, issueId, slotId, name);
    this.setAttachmentSlots(
      issueId,
      (this.attachmentSlots[issueId] ?? []).map((current) =>
        current.id === slotId ? Object.assign({}, current, { name: slot.name }) : current
      )
    );
    return slot;
  };

  removeAttachmentSlot = async (workspaceSlug: string, projectId: string, issueId: string, slotId: string) => {
    this.nextSlotRequest(issueId);
    await this.attachmentTemplateService.deleteSlot(workspaceSlug, projectId, issueId, slotId);
    this.setAttachmentSlots(
      issueId,
      (this.attachmentSlots[issueId] ?? []).filter((slot) => slot.id !== slotId)
    );
  };

  applyAttachmentTemplate = async (workspaceSlug: string, projectId: string, issueId: string, templateId: string) => {
    this.nextSlotRequest(issueId);
    const slots = await this.attachmentTemplateService.applyTemplate(workspaceSlug, projectId, issueId, templateId);
    this.setAttachmentSlots(issueId, slots);
    return slots;
  };

  getAttachmentById = (attachmentId: string) => {
    if (!attachmentId) return undefined;
    return this.attachmentMap[attachmentId] ?? undefined;
  };

  getAttachmentsCountByIssueId = (issueId: string) => {
    const attachments = this.getAttachmentsByIssueId(issueId);
    return attachments?.length ?? 0;
  };

  // actions
  addAttachments = (issueId: string, attachments: TIssueAttachment[]) => {
    if (attachments && attachments.length > 0) {
      const newAttachmentIds = attachments.map((attachment) => attachment.id);
      runInAction(() => {
        update(this.attachments, [issueId], (attachmentIds = []) => uniq(concat(attachmentIds, newAttachmentIds)));
        attachments.forEach((attachment) => set(this.attachmentMap, attachment.id, attachment));
      });
    }
  };

  fetchAttachments = async (workspaceSlug: string, projectId: string, issueId: string) => {
    const response = await this.issueAttachmentService.getIssueAttachments(workspaceSlug, projectId, issueId);
    this.addAttachments(issueId, response);
    return response;
  };

  private debouncedUpdateProgress = debounce((issueId: string, tempId: string, progress: number) => {
    runInAction(() => {
      if (!this.attachmentsUploadStatusMap[issueId]?.[tempId]) return;
      set(this.attachmentsUploadStatusMap, [issueId, tempId, "progress"], progress);
    });
  }, 16);

  createAttachment = async (workspaceSlug: string, projectId: string, issueId: string, file: File, slotId?: string) => {
    const tempId = uuidv4();
    try {
      // update attachment upload status
      runInAction(() => {
        set(this.attachmentsUploadStatusMap, [issueId, tempId], {
          id: tempId,
          name: file.name,
          progress: 0,
          size: file.size,
          type: file.type,
        });
      });
      const response = await this.issueAttachmentService.uploadIssueAttachment(
        workspaceSlug,
        projectId,
        issueId,
        file,
        (progressEvent) => {
          const progressPercentage = Math.round((progressEvent.progress ?? 0) * 100);
          this.debouncedUpdateProgress(issueId, tempId, progressPercentage);
        },
        slotId
      );

      if (response && response.id) {
        runInAction(() => {
          update(this.attachments, [issueId], (attachmentIds = []) => uniq(concat(attachmentIds, [response.id])));
          set(this.attachmentMap, response.id, response);
          this.rootIssueStore.issues.updateIssue(issueId, {
            attachment_count: this.getAttachmentsCountByIssueId(issueId),
          });
        });
        if (slotId) {
          this.setAttachmentSlots(
            issueId,
            (this.attachmentSlots[issueId] ?? []).map((slot) =>
              slot.id === slotId ? Object.assign({}, slot, { attachment: response }) : slot
            )
          );
          // The file is already committed; a refresh failure must not invite a duplicate upload.
          await this.fetchAttachmentSlots(workspaceSlug, projectId, issueId).catch((error) => {
            console.error("Error refreshing attachment slots after upload:", error);
          });
        }
      }

      return response;
    } catch (error) {
      console.error("Error in uploading issue attachment:", error);
      throw error;
    } finally {
      runInAction(() => {
        delete this.attachmentsUploadStatusMap[issueId][tempId];
      });
    }
  };

  removeAttachment = async (workspaceSlug: string, projectId: string, issueId: string, attachmentId: string) => {
    const response = await this.issueAttachmentService.deleteIssueAttachment(
      workspaceSlug,
      projectId,
      issueId,
      attachmentId
    );

    runInAction(() => {
      update(this.attachments, [issueId], (attachmentIds = []) => {
        if (attachmentIds.includes(attachmentId)) pull(attachmentIds, attachmentId);
        return attachmentIds;
      });
      delete this.attachmentMap[attachmentId];
      if (this.attachmentSlots[issueId]) {
        this.setAttachmentSlots(
          issueId,
          this.attachmentSlots[issueId].map((slot) =>
            slot.attachment?.id === attachmentId ? Object.assign({}, slot, { attachment: null }) : slot
          )
        );
      }
      this.rootIssueStore.issues.updateIssue(issueId, {
        attachment_count: this.getAttachmentsCountByIssueId(issueId),
      });
    });

    return response;
  };
}
