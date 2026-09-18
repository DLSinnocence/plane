/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Maximize2,
  Minimize2,
  Plus,
  Settings2,
  Sparkles,
  Square,
  X,
} from "lucide-react";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import { useTranslation } from "@plane/i18n";
import { ChatMarkdown } from "@plane/ui";
import { useUser } from "@/hooks/store/user";
import { useCommandPalette } from "@/hooks/store/use-command-palette";
import { AgentRequestError, startAgentChat } from "@/services/agent.service";
import { getWorkspaceAISettings } from "@/services/workspace-ai.service";
import type { AISettings } from "@/helpers/agent-settings";
import { AgentStreamError, readAgentStream } from "@/helpers/agent-stream";
import type { AgentImage, AgentMessage } from "@/helpers/agent-stream";
import { agentAnswerContent, parseAgentContent } from "@/helpers/agent-content";
import { agentWorkItemHref, canSendAgentMessage, collectAgentWorkItems, updateAgentTools } from "@/helpers/agent-chat";
import type { AgentToolProgress } from "@/helpers/agent-chat";
import { canAddAgentImages, readAgentImage } from "@/helpers/agent-images";
import { AgentImagePreviews } from "./agent-image-previews";
import { AgentMessageContent, useAgentMarkdownLabels } from "./agent-message-content";
import { AgentToolDetails } from "./agent-tool-details";

type ChatError = { message: string; code?: string; mayHaveChanges: boolean };
type WorkspaceChatModel = { id: string; name: string; supportsImages: boolean };
type ChatMessage = AgentMessage & {
  id: number;
  thinking?: string;
  tools?: AgentToolProgress[];
  duration?: number;
  error?: ChatError;
  contextContent?: string;
};
const errorKeys: Record<string, string> = {
  ai_service_not_configured: "service_unavailable",
  ai_service_unavailable: "service_unavailable",
  ai_service_auth: "service_unavailable",
  ai_model_not_configured: "configure_required",
  ai_images_disabled: "image_vision_required",
  ai_access_denied: "access_denied",
  ai_key_unreadable: "key_unreadable",
  ai_busy: "service_busy",
  ai_run_limit: "run_limit",
  ai_idle_timeout: "idle_timeout",
  ai_model_output_limit: "model_output_limit",
  ai_output_limit: "output_limit",
  ai_model_error: "model_error",
  ai_empty_response: "empty_response",
  ai_tools_unavailable: "tools_unavailable",
  ai_connection_interrupted: "connection_error",
};
const mutationActions = new Set(["create", "update", "manage_assignee", "manage_label", "manage_workitems"]);
const elapsed = (ms: number) =>
  ms < 60_000 ? `${Math.max(1, Math.round(ms / 1000))}s` : `${Math.floor(ms / 60_000)}m ${Math.round(ms / 1000) % 60}s`;

function MessageCopy({ text }: { text: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      className="agent-icon-button agent-message-copy"
      aria-label={t("account_settings.ai.copy_reply")}
      title={t("account_settings.ai.copy_reply")}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setCopied(true);
          setFailed(false);
        } catch {
          setFailed(true);
        }
      }}
    >
      {copied ? <Check size={14} /> : <Copy size={14} />}
      <span className="sr-only" role="status">
        {copied ? t("account_settings.ai.copied") : failed ? t("account_settings.ai.copy_failed") : ""}
      </span>
    </button>
  );
}

export const AIAssistant = observer(function AIAssistant() {
  const { data: user } = useUser();
  const { workspaceSlug, projectId } = useParams();
  if (!user?.id || typeof workspaceSlug !== "string") return null;
  return (
    <ScopedAssistant
      key={`${user.id}:${workspaceSlug}`}
      workspaceSlug={workspaceSlug}
      projectId={typeof projectId === "string" ? projectId : undefined}
    />
  );
});

const ScopedAssistant = observer(function ScopedAssistant({
  workspaceSlug,
  projectId,
}: {
  workspaceSlug: string;
  projectId?: string;
}) {
  const { t } = useTranslation();
  const markdownLabels = useAgentMarkdownLabels();
  const { profileSettingsModal } = useCommandPalette();
  const settingsOpen = profileSettingsModal.isOpen;
  const [open, setOpen] = useState(false);
  const [wide, setWide] = useState(false);
  const [dock, setDock] = useState<HTMLElement | null>(null);
  const [settings, setSettings] = useState<AISettings | null>(null);
  const [models, setModels] = useState<WorkspaceChatModel[]>([]);
  const [selectedModelId, setSelectedModelId] = useState<string | null>(null);
  const [loadingSettings, setLoadingSettings] = useState(false);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState("");
  const [attachments, setAttachments] = useState<AgentImage[]>([]);
  const [pendingImages, setPendingImages] = useState<AgentImage[]>([]);
  const [pendingUser, setPendingUser] = useState("");
  const [partial, setPartial] = useState("");
  const [thinking, setThinking] = useState("");
  const [activity, setActivity] = useState<"thinking" | "text" | "tool" | null>(null);
  const [tools, setTools] = useState<AgentToolProgress[]>([]);
  const [busy, setBusy] = useState(false);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [error, setError] = useState<ChatError | null>(null);
  const [following, setFollowing] = useState(true);
  const [duration, setDuration] = useState(0);
  const [reload, setReload] = useState(0);
  const run = useRef<AbortController | null>(null);
  const loading = useRef<AbortController | null>(null);
  const imageReader = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const conversation = useRef<HTMLDivElement | null>(null);
  const content = useRef<HTMLDivElement | null>(null);
  const composer = useRef<HTMLTextAreaElement | null>(null);
  const imagePicker = useRef<HTMLInputElement | null>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  const followLatest = useRef(true);
  const startedAt = useRef(0);
  const configured = Boolean(settings?.has_api_key);
  const supportsImages = Boolean(settings?.supports_images);
  const focusComposer = () => requestAnimationFrame(() => composer.current?.focus());
  useEffect(() => {
    setDock(document.getElementById("workspace-ai-sidebar"));
  }, []);
  useEffect(
    () => () => {
      run.current?.abort();
      loading.current?.abort();
      imageReader.current?.abort();
    },
    []
  );
  useEffect(() => {
    if (!open || settingsOpen) return;
    loading.current?.abort();
    const request = new AbortController();
    loading.current = request;
    setLoadingSettings(true);
    void getWorkspaceAISettings(workspaceSlug, request.signal)
      .then((value) => {
        if (request.signal.aborted) return undefined;
        const availableModels = value.providers.flatMap((provider) =>
          provider.is_enabled && provider.has_api_key
            ? provider.models
                .filter((model) => model.is_enabled)
                .map((model) => ({
                  id: model.id,
                  name: model.model,
                  supportsImages: model.supports_images,
                  isDefault: model.is_default,
                }))
            : []
        );
        const selected =
          availableModels.find((model) => model.id === selectedModelId) ??
          availableModels.find((model) => model.isDefault) ??
          availableModels[0];
        setModels(availableModels);
        setSelectedModelId(selected?.id ?? null);
        setSettings(
          selected
            ? {
                provider: "openai",
                base_url: "",
                model: selected.name,
                has_api_key: true,
                supports_images: selected.supportsImages,
              }
            : null
        );
        return undefined;
      })
      .catch((failure: unknown) => {
        if (!request.signal.aborted) {
          setSettings(null);
          setError({ message: failure instanceof Error ? failure.message : "", mayHaveChanges: false });
        }
      })
      .finally(() => {
        if (!request.signal.aborted) setLoadingSettings(false);
      });
    return () => request.abort();
  }, [open, settingsOpen, reload, selectedModelId, workspaceSlug]);
  useEffect(() => {
    if (open && !settingsOpen && configured) focusComposer();
  }, [open, settingsOpen, configured]);
  useEffect(() => {
    if (!busy) return;
    const timer = setInterval(() => setDuration(Date.now() - startedAt.current), 1000);
    return () => clearInterval(timer);
  }, [busy]);
  useEffect(() => {
    const element = composer.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${Math.min(180, Math.max(64, element.scrollHeight))}px`;
  }, [draft, open, configured]);
  useEffect(() => {
    if (!open || !content.current) return;
    const resize = new ResizeObserver(() => {
      if (followLatest.current && conversation.current)
        conversation.current.scrollTop = conversation.current.scrollHeight;
    });
    resize.observe(content.current);
    const element = conversation.current;
    const toggle = (event: Event) => {
      const summary = event.target instanceof Element ? event.target.closest("summary") : null;
      const details = summary?.parentElement;
      // Only a user's expansion pauses following; streamed thoughts open automatically.
      if (details instanceof HTMLDetailsElement && !details.open) {
        followLatest.current = false;
        setFollowing(false);
      }
    };
    element?.addEventListener("click", toggle, true);
    return () => {
      resize.disconnect();
      element?.removeEventListener("click", toggle, true);
    };
  }, [open, loadingSettings]);
  const reset = () => {
    run.current?.abort();
    run.current = null;
    imageReader.current?.abort();
    imageReader.current = null;
    setHistory([]);
    setDraft("");
    setAttachments([]);
    setPendingUser("");
    setPendingImages([]);
    setPartial("");
    setThinking("");
    setActivity(null);
    setTools([]);
    setError(null);
    setImageError(null);
    setBusy(false);
    setImageLoading(false);
    setDuration(0);
    followLatest.current = true;
    setFollowing(true);
    focusComposer();
  };
  const close = () => {
    run.current?.abort();
    imageReader.current?.abort();
    setOpen(false);
    trigger.current?.focus();
  };
  const configure = () => {
    window.location.assign(`/${workspaceSlug}/settings/ai/`);
  };
  const selectModel = (modelId: string) => {
    const model = models.find((item) => item.id === modelId);
    if (!model) return;
    setSelectedModelId(model.id);
    setSettings({
      provider: "openai",
      base_url: "",
      model: model.name,
      has_api_key: true,
      supports_images: model.supportsImages,
    });
    setImageError(null);
  };
  const addImages = async (files: File[]) => {
    if (!files.length || busy || imageLoading || imageReader.current) return;
    setImageError(null);
    if (!supportsImages) {
      setImageError(t("account_settings.ai.image_vision_required"));
      return;
    }
    const previous = history.reduce((count, message) => count + (message.images?.length ?? 0), 0);
    if (!canAddAgentImages(previous + attachments.length, files.length)) {
      setImageError(t("account_settings.ai.image_limit"));
      return;
    }
    const request = new AbortController();
    imageReader.current = request;
    setImageLoading(true);
    try {
      const images = await Promise.all(files.map((file) => readAgentImage(file, request.signal)));
      if (!request.signal.aborted) setAttachments((current) => [...current, ...images]);
    } catch {
      if (!request.signal.aborted) setImageError(t("account_settings.ai.image_invalid"));
    } finally {
      if (imageReader.current === request) {
        imageReader.current = null;
        setImageLoading(false);
      }
    }
  };
  const workItems = useMemo(
    () =>
      collectAgentWorkItems([...history.flatMap((message) => message.tools ?? []), ...tools]).flatMap((item) =>
        item.identifier
          ? [{ identifier: item.identifier, title: item.name, href: agentWorkItemHref(workspaceSlug, item) }]
          : []
      ),
    [history, tools, workspaceSlug]
  );
  const errorText = (failure: ChatError) =>
    failure.code && errorKeys[failure.code]
      ? t(`account_settings.ai.${errorKeys[failure.code]}`)
      : failure.message || t("account_settings.ai.connection_error");
  const sendEnabled = canSendAgentMessage(
    draft,
    busy || imageLoading,
    configured,
    supportsImages ? attachments.length : 0
  );
  const send = async () => {
    if (!sendEnabled || imageReader.current || run.current) return;
    const prompt = draft.trim();
    const sentImages = attachments;
    const request = new AbortController();
    run.current = request;
    const messages: AgentMessage[] = history.flatMap((message) => {
      const answer =
        message.contextContent ||
        (message.role === "assistant" ? agentAnswerContent(message.content) : message.content);
      return answer.trim() || message.images?.length
        ? [{ role: message.role, content: answer, ...(message.images?.length ? { images: message.images } : {}) }]
        : [];
    });
    messages.push({ role: "user", content: prompt, ...(sentImages.length ? { images: sentImages } : {}) });
    setBusy(true);
    setError(null);
    setImageError(null);
    setDraft("");
    setAttachments([]);
    setPendingUser(prompt);
    setPendingImages(sentImages);
    setPartial("");
    setThinking("");
    setActivity(null);
    setTools([]);
    startedAt.current = Date.now();
    setDuration(0);
    followLatest.current = true;
    setFollowing(true);
    let text = "",
      thought = "";
    let turnTools: AgentToolProgress[] = [];
    let turnActivity: typeof activity = null;
    let received = false;
    let mutationStarted = false;
    let renderTimer: number | undefined;
    const flush = () => {
      if (renderTimer !== undefined) clearTimeout(renderTimer);
      renderTimer = undefined;
      if (run.current === request) {
        setPartial(text);
        setThinking(thought);
        setActivity(turnActivity);
        setTools(turnTools);
      }
    };
    const schedule = () => {
      renderTimer ??= window.setTimeout(flush, 40);
    };
    const clearPending = () => {
      setPendingUser("");
      setPendingImages([]);
      setPartial("");
      setThinking("");
      setTools([]);
    };
    try {
      const body = await startAgentChat(
        workspaceSlug,
        messages,
        projectId,
        selectedModelId ?? undefined,
        request.signal
      );
      await readAgentStream(
        body,
        (event) => {
          if (request.signal.aborted) return;
          if (event.type === "text" && event.text) {
            text += event.text;
            turnActivity = parseAgentContent(text, true).at(-1)?.kind === "thinking" ? "thinking" : "text";
            received = true;
          }
          if (event.type === "thinking" && event.text) {
            thought += event.text;
            turnActivity = "thinking";
            received = true;
          }
          if (event.type === "tool") {
            turnTools = updateAgentTools(turnTools, event);
            turnActivity = turnTools.some((tool) => tool.status === "running") ? "tool" : null;
            received = true;
            if (mutationActions.has(event.action ?? "")) mutationStarted = true;
          }
          schedule();
        },
        request.signal
      );
      request.signal.throwIfAborted();
      flush();
      if (!agentAnswerContent(text).trim()) throw new AgentStreamError(t("account_settings.ai.empty_response"));
      setHistory([
        ...history,
        { id: ++sequence.current, role: "user", content: prompt, ...(sentImages.length ? { images: sentImages } : {}) },
        {
          id: ++sequence.current,
          role: "assistant",
          content: text,
          thinking: thought,
          tools: turnTools,
          duration: Date.now() - startedAt.current,
        },
      ]);
      clearPending();
    } catch (failure: unknown) {
      if (run.current !== request) return;
      flush();
      const noExecution =
        failure instanceof AgentRequestError ||
        (failure instanceof AgentStreamError && failure.mayHaveChanges === false);
      const mayHaveChanges = noExecution
        ? false
        : failure instanceof AgentStreamError && failure.mayHaveChanges !== undefined
          ? failure.mayHaveChanges
          : mutationStarted;
      const problem: ChatError = {
        message: request.signal.aborted
          ? t("account_settings.ai.cancelled")
          : failure instanceof Error
            ? failure.message
            : "",
        code: failure instanceof AgentRequestError || failure instanceof AgentStreamError ? failure.code : undefined,
        mayHaveChanges,
      };
      if (!received && !mayHaveChanges) {
        setDraft(prompt);
        setAttachments(sentImages);
        setError(problem);
        clearPending();
      } else {
        const summary = mayHaveChanges
          ? "The previous request stopped after tool writes may have started. Verify the current Plane state before repeating any mutation."
          : "The previous response did not complete. No tool writes were started.";
        setHistory([
          ...history,
          {
            id: ++sequence.current,
            role: "user",
            content: prompt,
            ...(sentImages.length ? { images: sentImages } : {}),
          },
          {
            id: ++sequence.current,
            role: "assistant",
            content: text,
            thinking: thought,
            tools: turnTools,
            error: problem,
            contextContent: `${agentAnswerContent(text)}\n\n${summary}`,
            duration: Date.now() - startedAt.current,
          },
        ]);
        clearPending();
      }
    } finally {
      if (renderTimer !== undefined) clearTimeout(renderTimer);
      if (run.current === request) {
        run.current = null;
        setBusy(false);
        focusComposer();
      }
    }
  };
  const stop = () => run.current?.abort();
  const verify = () => {
    setDraft(t("account_settings.ai.verify_prompt"));
    focusComposer();
  };
  const suggestion = (key: string) => {
    setDraft(t(`account_settings.ai.${key}`));
    focusComposer();
  };
  const panel = (
    <aside
      className={`agent-sidebar${wide ? " agent-sidebar--wide" : ""}${dock ? "" : " agent-sidebar--floating"}`}
      aria-label={t("account_settings.ai.title")}
      onKeyDown={(event) => {
        if (event.key === "Escape" && !settingsOpen && !(event.target as HTMLElement).closest("[role=listbox]")) {
          event.stopPropagation();
          close();
        }
      }}
    >
      <header className="agent-sidebar-header">
        <div className="agent-sidebar-brand">
          <span className="agent-brand-icon">
            <Sparkles size={16} />
          </span>
          <div>
            <h2>{t("account_settings.ai.title")}</h2>
            <span>{workspaceSlug}</span>
          </div>
        </div>
        <div className="agent-sidebar-actions">
          <button
            type="button"
            className="agent-icon-button"
            onClick={reset}
            aria-label={t("account_settings.ai.new_chat")}
            title={t("account_settings.ai.new_chat")}
          >
            <Plus size={17} />
          </button>
          <button
            type="button"
            className="agent-icon-button agent-expand-button"
            onClick={() => setWide(!wide)}
            aria-label={t(wide ? "account_settings.ai.collapse_panel" : "account_settings.ai.expand_panel")}
            title={t(wide ? "account_settings.ai.collapse_panel" : "account_settings.ai.expand_panel")}
          >
            {wide ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button
            type="button"
            className="agent-icon-button"
            disabled={busy}
            onClick={configure}
            aria-label={t("account_settings.ai.model_settings")}
            title={t("account_settings.ai.model_settings")}
          >
            <Settings2 size={16} />
          </button>
          <button
            type="button"
            className="agent-icon-button"
            onClick={close}
            aria-label={t("account_settings.ai.close")}
            title={t("account_settings.ai.close")}
          >
            <X size={18} />
          </button>
        </div>
      </header>
      <div
        ref={conversation}
        className="agent-conversation"
        aria-label={t("account_settings.ai.conversation")}
        onScroll={(event) => {
          const element = event.currentTarget;
          const pinned = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
          followLatest.current = pinned;
          setFollowing(pinned);
        }}
      >
        <div ref={content} className="agent-conversation-content">
          {!history.length && !busy && !pendingUser && !pendingImages.length && (
            <div className="agent-empty-state">
              <div className="agent-empty-spark">
                <Sparkles size={29} />
              </div>
              <h3>{t(configured ? "account_settings.ai.empty_title" : "account_settings.ai.connect_title")}</h3>
              <p>
                {t(configured ? "account_settings.ai.empty_description" : "account_settings.ai.connect_description")}
              </p>
              {loadingSettings ? (
                <span role="status" className="agent-muted">
                  {t("account_settings.ai.loading")}
                </span>
              ) : !configured ? (
                <button type="button" className="agent-primary-button" onClick={configure}>
                  {t("account_settings.ai.configure")}
                </button>
              ) : (
                <div className="agent-suggestions">
                  {["suggest_tasks", "suggest_create", "suggest_image"].map((key) => (
                    <button key={key} type="button" onClick={() => suggestion(key)}>
                      {t(`account_settings.ai.${key}`)}
                      <ArrowUp size={13} />
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {history.map((message) => (
            <article
              key={message.id}
              className={`agent-turn agent-turn--${message.role}`}
              aria-label={t(message.role === "user" ? "account_settings.ai.you" : "account_settings.ai.title")}
            >
              {message.role === "user" ? (
                <>
                  <div className="agent-user-bubble">
                    <ChatMarkdown content={message.content} labels={markdownLabels} />
                    <AgentImagePreviews images={message.images} />
                  </div>
                  <div className="agent-message-actions">
                    <MessageCopy text={message.content} />
                  </div>
                </>
              ) : (
                <>
                  <div className="agent-turn-progress">
                    {message.duration && (
                      <span>
                        {t("account_settings.ai.elapsed")} {elapsed(message.duration)}
                      </span>
                    )}
                  </div>
                  <AgentMessageContent content={message.content} thinking={message.thinking} workItems={workItems} />
                  <AgentToolDetails tools={message.tools ?? []} workspaceSlug={workspaceSlug} />
                  {message.error && (
                    <div className="agent-inline-error" role="alert">
                      <p>{errorText(message.error)}</p>
                      {message.error.mayHaveChanges && (
                        <>
                          <p>{t("account_settings.ai.check_changes")}</p>
                          <button type="button" onClick={verify}>
                            {t("account_settings.ai.verify_changes")}
                          </button>
                        </>
                      )}
                    </div>
                  )}
                  {agentAnswerContent(message.content) && (
                    <div className="agent-message-actions">
                      <MessageCopy text={agentAnswerContent(message.content)} />
                    </div>
                  )}
                </>
              )}
            </article>
          ))}
          {(pendingUser || pendingImages.length > 0) && (
            <article className="agent-turn agent-turn--user" aria-label={t("account_settings.ai.you")}>
              <div className="agent-user-bubble">
                <ChatMarkdown content={pendingUser} labels={markdownLabels} />
                <AgentImagePreviews images={pendingImages} />
              </div>
            </article>
          )}
          {busy && (
            <article className="agent-turn agent-turn--assistant" aria-label={t("account_settings.ai.title")}>
              <div className="agent-live-status" role="status">
                <span className="agent-live-dot" />
                {t(
                  activity === "tool"
                    ? "account_settings.ai.working_tools"
                    : activity === "thinking"
                      ? "account_settings.ai.working_thinking"
                      : activity === "text"
                        ? "account_settings.ai.working_answer"
                        : "account_settings.ai.loading"
                )}
                <span>{elapsed(duration)}</span>
              </div>
              <AgentMessageContent
                content={partial}
                thinking={thinking}
                streaming
                thinkingActive={activity === "thinking"}
                workItems={workItems}
              />
              <AgentToolDetails tools={tools} workspaceSlug={workspaceSlug} />
            </article>
          )}
        </div>
      </div>
      <footer className="agent-sidebar-footer">
        {!following && (
          <button
            type="button"
            className="agent-jump-latest"
            aria-label={t("account_settings.ai.scroll_latest")}
            title={t("account_settings.ai.scroll_latest")}
            onClick={() => {
              followLatest.current = true;
              setFollowing(true);
              if (conversation.current) conversation.current.scrollTop = conversation.current.scrollHeight;
            }}
          >
            <ArrowDown size={17} />
          </button>
        )}
        {error && (
          <div className="agent-inline-error" role="alert">
            <p>{errorText(error)}</p>
            <div>
              <button
                type="button"
                onClick={() => {
                  setError(null);
                  setReload((value) => value + 1);
                  focusComposer();
                }}
              >
                {t("account_settings.ai.retry_connection")}
              </button>
              {error.code === "ai_model_not_configured" && (
                <button type="button" onClick={configure}>
                  {t("account_settings.ai.configure")}
                </button>
              )}
            </div>
          </div>
        )}
        {imageError && (
          <p role="alert" className="agent-image-error">
            {imageError}
          </p>
        )}
        <form
          className="agent-chat-composer"
          onSubmit={(event) => {
            event.preventDefault();
            void send();
          }}
          onDragOver={(event) => {
            if (event.dataTransfer.types.includes("Files")) event.preventDefault();
          }}
          onDrop={(event) => {
            if (event.dataTransfer.files.length) {
              event.preventDefault();
              void addImages(Array.from(event.dataTransfer.files));
            }
          }}
        >
          <AgentImagePreviews
            images={attachments}
            onRemove={(index) => setAttachments((current) => current.filter((_image, position) => position !== index))}
          />
          <input
            ref={imagePicker}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            multiple
            className="hidden"
            aria-label={t("account_settings.ai.image_add")}
            disabled={!supportsImages || busy || imageLoading}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              void addImages(files);
            }}
          />
          <textarea
            ref={composer}
            aria-label={t("account_settings.ai.message")}
            placeholder={t("account_settings.ai.composer_placeholder")}
            value={draft}
            disabled={busy || !configured}
            rows={2}
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void send();
              }
            }}
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.items)
                .filter((item) => item.kind === "file" && item.type.startsWith("image/"))
                .map((item) => item.getAsFile())
                .filter((file): file is File => file !== null);
              if (files.length) {
                event.preventDefault();
                void addImages(files);
              }
            }}
          />
          <div className="agent-composer-toolbar">
            <button
              type="button"
              className="agent-icon-button agent-attach-button"
              disabled={!supportsImages || busy || imageLoading}
              onClick={() => imagePicker.current?.click()}
              aria-label={t("account_settings.ai.image_add")}
              title={
                supportsImages ? t("account_settings.ai.image_add") : t("account_settings.ai.image_vision_required")
              }
            >
              <Plus size={19} />
            </button>
            <select
              className="agent-model-button"
              aria-label={t("account_settings.ai.select_model")}
              disabled={busy || models.length === 0}
              value={selectedModelId ?? ""}
              onChange={(event) => selectModel(event.target.value)}
            >
              {models.map((model) => (
                <option key={model.id} value={model.id}>
                  {model.name}
                </option>
              ))}
            </select>
            {imageLoading && (
              <span role="status" className="agent-upload-status">
                {t("account_settings.ai.image_uploading")}
              </span>
            )}
            {busy ? (
              <button
                type="button"
                className="agent-send-button agent-stop-button"
                onClick={stop}
                aria-label={t("account_settings.ai.cancel")}
                title={t("account_settings.ai.cancel")}
              >
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button
                type="submit"
                className="agent-send-button"
                disabled={!sendEnabled}
                aria-label={t("account_settings.ai.send")}
                title={t("account_settings.ai.send")}
              >
                <ArrowUp size={19} />
              </button>
            )}
          </div>
        </form>
        <p className="agent-composer-hint">{t("account_settings.ai.composer_hint")}</p>
      </footer>
    </aside>
  );
  return (
    <>
      <button
        ref={trigger}
        type="button"
        className={`agent-launcher${open ? " agent-launcher--active" : ""}`}
        aria-label={t("account_settings.ai.title")}
        aria-expanded={open}
        title={t("account_settings.ai.title")}
        onClick={() => (open ? close() : setOpen(true))}
      >
        <Sparkles size={15} />
        <span>AI</span>
      </button>
      {open && typeof document !== "undefined" && createPortal(panel, dock ?? document.body)}
    </>
  );
});
