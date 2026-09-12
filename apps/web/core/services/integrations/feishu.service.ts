/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { API_BASE_URL } from "@plane/constants";
import { APIService } from "@/services/api.service";

export type FeishuConfiguration = {
  id: string | null;
  app_id: string;
  enabled: boolean;
  has_app_secret: boolean;
};
export type FeishuConfigurationUpdate = { app_id: string; app_secret?: string; enabled: boolean };
export type FeishuRecipient = { user_id: string; has_mobile: boolean; mobile_hint: string };
export type FeishuDelivery = {
  id: string;
  issue_id: string | null;
  receiver_id: string;
  status: string;
  attempts: number;
  last_error: string;
  created_at: string;
  sent_at: string | null;
};

export class FeishuService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  private path(workspaceSlug: string) {
    return `/api/workspaces/${encodeURIComponent(workspaceSlug)}/integrations/feishu/`;
  }

  async getConfiguration(workspaceSlug: string): Promise<FeishuConfiguration> {
    return this.get(this.path(workspaceSlug)).then((response) => response.data);
  }

  async updateConfiguration(workspaceSlug: string, data: FeishuConfigurationUpdate): Promise<FeishuConfiguration> {
    return this.patch(this.path(workspaceSlug), data).then((response) => response.data);
  }

  async getRecipients(workspaceSlug: string): Promise<FeishuRecipient[]> {
    return this.get(`${this.path(workspaceSlug)}recipients/`).then((response) => response.data);
  }

  async getDeliveries(workspaceSlug: string): Promise<FeishuDelivery[]> {
    return this.get(`${this.path(workspaceSlug)}deliveries/`).then((response) => response.data);
  }

  async sendTest(workspaceSlug: string, userId: string): Promise<void> {
    await this.post(`${this.path(workspaceSlug)}test/`, { user_id: userId });
  }
}
