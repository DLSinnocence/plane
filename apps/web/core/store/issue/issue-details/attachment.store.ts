/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { uniq, set, debounce, update, concat, sortBy } from "lodash-es";
import { action, computed, makeObservable, observable, runInAction } from "mobx";
import { computedFn } from "mobx-utils";
import { EIssueServiceType } from "@plane/types";
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
  private attachmentRequestVersions: Record<string, number> = {};
  private deletedAttachmentIds = new Set<string>();
  private deletedSlotIds = new Set<string>();
  private serviceType: TIssueServiceType;
  attachmentsUploadStatusMap: Record<string, Record<string, TAttachmentUploadStatus>> = {};
  // root store
  rootIssueStore: IIssueRootStore;
  rootIssueDetailStore: IIssueDetail;
  // services
  issueAttachmentService;
  private attachmentTemplateService = new AttachmentTemplateService();

  constructor(rootStore: IIssueRootStore, serviceType: TIssueServiceType) {
    this.serviceType = serviceType;
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
    const currentSlots = slots
      .filter((slot) => !this.deletedSlotIds.has(slot.id))
      .map((slot) =>
        slot.attachment && this.deletedAttachmentIds.has(slot.attachment.id)
          ? Object.assign({}, slot, { attachment: null })
          : slot
      );
    runInAction(() => {
      const currentIds = new Set(currentSlots.flatMap((slot) => (slot.attachment ? [slot.attachment.id] : [])));
      const removedIds = (this.attachmentSlots[issueId] ?? []).flatMap((slot) =>
        slot.attachment && !currentIds.has(slot.attachment.id) ? [slot.attachment.id] : []
      );
      if (removedIds.length) this.removeCachedAttachments(issueId, removedIds);
      this.attachmentSlots[issueId] = sortBy(currentSlots, "sort_order");
      this.addAttachments(
        issueId,
        currentSlots.flatMap((slot) => (slot.attachment ? [slot.attachment] : []))
      );
      this.rootIssueStore.issues.updateIssue(issueId, {
        attachment_count: currentSlots.filter((slot) => slot.attachment).length,
      });
    });
  }

  private removeCachedAttachments(issueId: string, attachmentIds: string[]) {
    this.attachmentRequestVersions[issueId] = (this.attachmentRequestVersions[issueId] ?? 0) + 1;
    for (const id of attachmentIds) this.deletedAttachmentIds.add(id);
    runInAction(() => {
      for (const id of attachmentIds) delete this.attachmentMap[id];
      this.attachments[issueId] = (this.attachments[issueId] ?? []).filter((id) => !this.deletedAttachmentIds.has(id));
      this.rootIssueStore.issues.updateIssue(issueId, { attachment_count: this.getAttachmentsCountByIssueId(issueId) });
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
    const result = await this.attachmentTemplateService.deleteSlot(workspaceSlug, projectId, issueId, slotId);
    runInAction(() => {
      this.deletedSlotIds.add(slotId);
      this.removeCachedAttachments(issueId, result.deleted_attachment_ids);
      this.setAttachmentSlots(
        issueId,
        (this.attachmentSlots[issueId] ?? []).filter((slot) => slot.id !== slotId)
      );
    });
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
    const current = attachments.filter((attachment) => !this.deletedAttachmentIds.has(attachment.id));
    if (current.length > 0) {
      this.attachmentRequestVersions[issueId] = (this.attachmentRequestVersions[issueId] ?? 0) + 1;
      const newAttachmentIds = current.map((attachment) => attachment.id);
      runInAction(() => {
        update(this.attachments, [issueId], (attachmentIds = []) => uniq(concat(attachmentIds, newAttachmentIds)));
        current.forEach((attachment) => set(this.attachmentMap, attachment.id, attachment));
      });
    }
  };

  fetchAttachments = async (workspaceSlug: string, projectId: string, issueId: string) => {
    const version = (this.attachmentRequestVersions[issueId] ?? 0) + 1;
    this.attachmentRequestVersions[issueId] = version;
    const response = await this.issueAttachmentService.getIssueAttachments(workspaceSlug, projectId, issueId);
    if (this.attachmentRequestVersions[issueId] === version) {
      const current = response.filter((attachment) => !this.deletedAttachmentIds.has(attachment.id));
      runInAction(() => {
        this.attachments[issueId] = current.map((attachment) => attachment.id);
        this.addAttachments(issueId, current);
        this.rootIssueStore.issues.updateIssue(issueId, { attachment_count: current.length });
      });
    }
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

      if (response && response.id && !this.deletedAttachmentIds.has(response.id)) {
        const assignedSlotId = response.attachment_slot_id ?? slotId;
        if (assignedSlotId && this.deletedSlotIds.has(assignedSlotId)) {
          this.removeCachedAttachments(issueId, [response.id]);
          return response;
        }
        runInAction(() => {
          this.removeCachedAttachments(issueId, response.deleted_attachment_ids ?? []);
          this.addAttachments(issueId, [response]);
          if (response.attachment_slot) {
            this.setAttachmentSlots(issueId, [
              ...(this.attachmentSlots[issueId] ?? []).filter((slot) => slot.id !== response.attachment_slot?.id),
              response.attachment_slot,
            ]);
          } else if (assignedSlotId) {
            this.setAttachmentSlots(
              issueId,
              (this.attachmentSlots[issueId] ?? []).map((slot) =>
                slot.id === assignedSlotId ? Object.assign({}, slot, { attachment: response }) : slot
              )
            );
          }
          this.rootIssueStore.issues.updateIssue(issueId, {
            attachment_count: this.getAttachmentsCountByIssueId(issueId),
          });
        });
        if (this.serviceType === EIssueServiceType.ISSUES) {
          // The committed row already exists locally; refresh failures must not invite another upload.
          await this.fetchAttachmentSlots(workspaceSlug, projectId, issueId).catch((error) => {
            console.error("Error refreshing attachment rows after upload:", error);
          });
        }
      }

      return response;
    } catch (error) {
      if (this.serviceType === EIssueServiceType.ISSUES) {
        await this.fetchAttachmentSlots(workspaceSlug, projectId, issueId).catch(() => undefined);
      }
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
      this.removeCachedAttachments(issueId, [attachmentId]);
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
