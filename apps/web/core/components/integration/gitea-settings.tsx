/**
 * Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only
 * See the LICENSE file for details.
 */

import { useEffect, useRef, useState } from "react";
import useSWR from "swr";
import { useTranslation } from "@plane/i18n";
import type { GiteaHooks } from "@plane/types";
import { AlertModalCore } from "@plane/ui";
import { GiteaService } from "@/services/integrations/gitea.service";

const service = new GiteaService();
const options = { revalidateOnFocus: false, shouldRetryOnError: false };
const inputClass = "w-full rounded-md border border-subtle bg-surface-1 px-3 py-2 text-13";
const buttonClass = "rounded-md border border-subtle px-3 py-2 text-13 disabled:cursor-not-allowed disabled:opacity-50";

export function GiteaSettings({ workspaceSlug }: { workspaceSlug: string }) {
  return <WorkspaceGiteaSettings key={workspaceSlug} workspaceSlug={workspaceSlug} />;
}

function WorkspaceGiteaSettings({ workspaceSlug }: { workspaceSlug: string }) {
  const { t } = useTranslation();
  const config = useSWR(["gitea-config", workspaceSlug], () => service.getConfig(workspaceSlug), options);
  const { data } = config;
  const [repositoryUrl, setRepositoryUrl] = useState("");
  // Never put generated scripts in SWR, a store, browser storage, or logs.
  const [hooks, setHooks] = useState<GiteaHooks | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [confirmation, setConfirmation] = useState<"disable" | "rotate" | null>(null);
  const generation = useRef(0);
  const actionLock = useRef(false);
  const mounted = useRef(true);
  const text = (key: string) => t(`gitea_integration.${key}`);

  function clearSecrets() {
    generation.current += 1;
    setHooks(null);
  }

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      generation.current += 1;
    };
  }, []);

  useEffect(() => {
    if (!data?.enabled) clearSecrets();
  }, [data?.enabled]);

  async function run(action: () => Promise<void>, success = "saved") {
    if (actionLock.current) return;
    actionLock.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await action();
      if (mounted.current) setNotice(text(success));
    } catch {
      if (mounted.current) setError(text("action_error"));
    } finally {
      actionLock.current = false;
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <section aria-labelledby="gitea-title" className="space-y-5 border-b border-subtle py-6">
      <div>
        <h4 id="gitea-title" className="text-16 font-medium">
          Gitea
        </h4>
        <p className="mt-1 text-13 text-secondary">{text("description")}</p>
        <p className="mt-2 text-13">{text("steps")}</p>
        <p className="mt-2 text-13">{text("commit_format")}</p>
      </div>
      {error && (
        <p role="alert" className="text-13 text-danger-primary">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="text-13">
          {notice}
        </p>
      )}
      {config.error ? (
        <div role="alert" className="space-y-2 text-13">
          <p>{text("load_error")}</p>
          <button className={buttonClass} onClick={() => void config.mutate().catch(() => undefined)}>
            {text("retry")}
          </button>
        </div>
      ) : !data ? (
        <p role="status">{text("loading")}</p>
      ) : (
        <>
          <p className="text-13">{text(data.enabled ? "enabled" : "disabled")}</p>
          <div className="flex flex-wrap gap-2">
            <button
              className={buttonClass}
              disabled={busy}
              onClick={() => {
                clearSecrets();
                if (data.enabled) setConfirmation("disable");
                else
                  void run(async () => {
                    await config.mutate(await service.updateConfig(workspaceSlug, { enabled: true }), false);
                  });
              }}
            >
              {text(data.enabled ? "disable" : "enable")}
            </button>
            <button
              className={buttonClass}
              disabled={busy || !data.has_secret}
              onClick={() => {
                clearSecrets();
                setConfirmation("rotate");
              }}
            >
              {text("rotate")}
            </button>
          </div>
          <div className="max-w-3xl space-y-2">
            {(["validation_url", "commits_url", "lookup_url", "issue_url_template"] as const).map((field) => (
              <div key={field} className="flex flex-wrap items-end gap-2">
                <label className="min-w-0 flex-1 space-y-1 text-13">
                  <span>{text(field)}</span>
                  <input readOnly className={inputClass} value={data[field]} />
                </label>
                <button
                  className={buttonClass}
                  disabled={busy || !data[field]}
                  onClick={() => void run(() => navigator.clipboard.writeText(data[field]), "url_copied")}
                >
                  {text(`copy_${field}`)}
                </button>
              </div>
            ))}
            <p className="text-13 text-secondary">{text("endpoints_help")}</p>
          </div>
          <form
            className="max-w-3xl space-y-4"
            onReset={() => {
              clearSecrets();
              setRepositoryUrl("");
              setError("");
              setNotice("");
            }}
            onSubmit={(event) => {
              event.preventDefault();
              clearSecrets();
              const requestGeneration = generation.current;
              void run(async () => {
                const result = await service.generateHooks(workspaceSlug, repositoryUrl.trim());
                if (mounted.current && requestGeneration === generation.current) setHooks(result);
              }, "hook_ready");
            }}
          >
            <label className="block space-y-1 text-13">
              <span>{text("repository_url")}</span>
              <input
                required
                type="url"
                pattern="https?://.+"
                autoComplete="off"
                className={inputClass}
                value={repositoryUrl}
                disabled={busy || !data.enabled}
                onChange={(event) => {
                  clearSecrets();
                  setRepositoryUrl(event.target.value);
                }}
                placeholder="https://gitea.example.com/team/repository"
              />
            </label>
            <p className="text-13 text-secondary">{text("repository_url_help")}</p>
            <div className="flex flex-wrap gap-2">
              <button type="submit" className={buttonClass} disabled={busy || !data.enabled}>
                {text("get_hooks")}
              </button>
              <button type="reset" className={buttonClass}>
                {text("reset")}
              </button>
            </div>
          </form>
          <div className="space-y-2 text-13 text-secondary">
            {[
              "hook_requirements",
              "hook_installation",
              "hook_existing",
              "hook_rejection",
              "post_receive_help",
              "work_item_links",
            ].map((key) => (
              <p key={key}>{text(key)}</p>
            ))}
          </div>
          {hooks && (
            <div className="space-y-4">
              <p className="text-13">{text("hook_help")}</p>
              {(["pre_receive", "post_receive"] as const).map((field) => (
                <div key={field} className="space-y-2">
                  <h5 className="text-14 font-medium">{hooks[field].filename}</h5>
                  <textarea
                    aria-label={text(`${field}_content`)}
                    readOnly
                    value={hooks[field].content}
                    className={`${inputClass} font-mono h-56`}
                  />
                  <div className="flex flex-wrap gap-2">
                    <button
                      className={buttonClass}
                      disabled={busy}
                      onClick={() => void run(() => navigator.clipboard.writeText(hooks[field].content), "copied")}
                    >
                      {text(`copy_${field}`)}
                    </button>
                    <button
                      className={buttonClass}
                      onClick={() => {
                        const url = URL.createObjectURL(
                          new Blob([hooks[field].content], { type: "application/octet-stream" })
                        );
                        const link = document.createElement("a");
                        link.href = url;
                        link.download = hooks[field].filename;
                        link.click();
                        URL.revokeObjectURL(url);
                      }}
                    >
                      {text(`download_${field}`)}
                    </button>
                  </div>
                </div>
              ))}
              <button className={buttonClass} onClick={clearSecrets}>
                {text("hide_hooks")}
              </button>
            </div>
          )}
        </>
      )}
      <AlertModalCore
        isOpen={!!confirmation}
        isSubmitting={busy}
        handleClose={() => {
          if (!busy) setConfirmation(null);
        }}
        title={text(confirmation === "rotate" ? "rotate" : "disable")}
        content={text(confirmation === "rotate" ? "rotate_warning" : "disable_warning")}
        primaryButtonText={{
          default: text(confirmation === "rotate" ? "rotate" : "disable"),
          loading: text("loading"),
        }}
        secondaryButtonText={text("cancel")}
        handleSubmit={async () => {
          if (!confirmation) return;
          const action = confirmation;
          clearSecrets();
          await run(
            async () => {
              const result =
                action === "rotate"
                  ? await service.rotateToken(workspaceSlug)
                  : await service.updateConfig(workspaceSlug, { enabled: false });
              if (mounted.current) {
                await config.mutate(result, false);
                setConfirmation(null);
              }
            },
            action === "rotate" ? "rotated" : "disabled_notice"
          );
        }}
      />
    </section>
  );
}
