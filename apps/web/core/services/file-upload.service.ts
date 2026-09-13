/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import type { AxiosRequestConfig } from "axios";
// services
import { APIService } from "@/services/api.service";

export class FileUploadService extends APIService {
  private abortController?: AbortController;

  constructor() {
    super("");
  }

  async uploadFile(
    url: string,
    data: FormData,
    uploadProgressHandler?: AxiosRequestConfig["onUploadProgress"]
  ): Promise<void> {
    const controller = new AbortController();
    this.abortController = controller;
    return this.post(url, data, {
      headers: {
        "Content-Type": "multipart/form-data",
      },
      signal: controller.signal,
      withCredentials: false,
      onUploadProgress: uploadProgressHandler,
    }).then((response) => response?.data);
  }

  cancelUpload() {
    this.abortController?.abort("Upload canceled");
  }
}
