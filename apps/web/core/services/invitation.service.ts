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
      ? `/api/workspaces/${encodeURIComponent(slug)}/projects/${encodeURIComponent(projectId)}/join/${encodeURIComponent(id)}/`
      : `/api/workspaces/${encodeURIComponent(slug)}/invitations/${encodeURIComponent(id)}/join/`;
  }

  async detail(slug: string, id: string, projectId?: string | null): Promise<InvitationDetail> {
    return this.get(this.endpoint(slug, id, projectId))
      .then((response) => {
        const data = response.data;
        if (
          !data ||
          typeof data !== "object" ||
          typeof data.id !== "string" ||
          !data.workspace ||
          typeof data.workspace.name !== "string" ||
          typeof data.workspace.slug !== "string" ||
          (data.email !== undefined && typeof data.email !== "string") ||
          (data.project != null && (typeof data.project.id !== "string" || typeof data.project.name !== "string"))
        )
          throw new Error("Invalid invitation response");
        return data;
      })
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }

  async respond(slug: string, id: string, token: string, accepted: boolean, projectId?: string | null): Promise<void> {
    return this.post(this.endpoint(slug, id, projectId), { token, accepted })
      .then(() => undefined)
      .catch((error) => {
        throw error?.response?.data ?? error;
      });
  }
}
