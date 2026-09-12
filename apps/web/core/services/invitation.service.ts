import { API_BASE_URL } from "@plane/constants";
import { APIService } from "@/services/api.service";

export type InvitationDetail = {
  id: string;
  email?: string;
  accepted: boolean;
  responded_at: string | null;
  workspace: { slug: string; name: string };
  project?: { id: string; name: string };
};

export class InvitationService extends APIService {
  constructor() {
    super(API_BASE_URL);
  }

  private endpoint(slug: string, id: string, projectId?: string | null) {
    return projectId
      ? `/api/workspaces/${slug}/projects/${projectId}/join/${id}/`
      : `/api/workspaces/${slug}/invitations/${id}/join/`;
  }

  async detail(slug: string, id: string, projectId?: string | null): Promise<InvitationDetail> {
    return this.get(this.endpoint(slug, id, projectId))
      .then((response) => response.data)
      .catch((error) => {
        throw error?.response?.data;
      });
  }

  async respond(slug: string, id: string, token: string, accepted: boolean, projectId?: string | null): Promise<void> {
    return this.post(this.endpoint(slug, id, projectId), { token, accepted })
      .then(() => undefined)
      .catch((error) => {
        throw error?.response?.data;
      });
  }
}
