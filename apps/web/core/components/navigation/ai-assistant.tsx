/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import { useEffect, useMemo, useRef, useState } from "react";
import { Dialog } from "@headlessui/react";
import { ArrowDown, ImagePlus, Sparkles, X } from "lucide-react";
import { observer } from "mobx-react";
import { useParams } from "next/navigation";
import { useLocation } from "react-router";
import { useTranslation } from "@plane/i18n";
import { Button } from "@plane/propel/button";
import { ChatMarkdown } from "@plane/ui";
import { useUser } from "@/hooks/store/user";
import { useCommandPalette } from "@/hooks/store/use-command-palette";
import { getAISettings, startAgentChat } from "@/services/agent.service";
import { readAgentStream } from "@/helpers/agent-stream";
import { agentAnswerContent } from "@/helpers/agent-content";
import { agentWorkItemHref, canSendAgentMessage, collectAgentWorkItems, updateAgentTools } from "@/helpers/agent-chat";
import type { AgentToolProgress } from "@/helpers/agent-chat";
import type { AgentImage, AgentMessage } from "@/helpers/agent-stream";
import { canAddAgentImages, readAgentImage } from "@/helpers/agent-images";
import { AgentImagePreviews } from "./agent-image-previews";
import { AgentMessageContent, useAgentMarkdownLabels } from "./agent-message-content";
import { AgentToolDetails } from "./agent-tool-details";

type ChatMessage = AgentMessage & { id: number; thinking?: string; tools?: AgentToolProgress[] };

export const AIAssistant = observer(function AIAssistant() {
  const { data: user } = useUser();
  const { workspaceSlug, projectId } = useParams();
  const location = useLocation();
  if (!user?.id || typeof workspaceSlug !== "string") return null;
  return (
    <ScopedAssistant
      key={JSON.stringify([
        user.id,
        workspaceSlug,
        projectId,
        location.key,
        location.pathname,
        location.search,
        location.hash,
      ])}
      workspaceSlug={workspaceSlug}
      projectId={typeof projectId === "string" ? projectId : undefined}
    />
  );
});

function ScopedAssistant({ workspaceSlug, projectId }: { workspaceSlug: string; projectId?: string }) {
  const { t } = useTranslation();
  const markdownLabels = useAgentMarkdownLabels();
  const { toggleProfileSettingsModal } = useCommandPalette();
  const [open, setOpen] = useState(false);
  const [configured, setConfigured] = useState<boolean | null>(null);
  const [history, setHistory] = useState<ChatMessage[]>([]);
  const [supportsImages, setSupportsImages] = useState(false);
  const [attachments, setAttachments] = useState<AgentImage[]>([]);
  const [pendingImages, setPendingImages] = useState<AgentImage[]>([]);
  const [imageLoading, setImageLoading] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const imageController = useRef<AbortController | null>(null);
  const imagePicker = useRef<HTMLInputElement | null>(null);
  const [draft, setDraft] = useState("");
  const [pendingUser, setPendingUser] = useState("");
  const [partial, setPartial] = useState("");
  const [thinking, setThinking] = useState("");
  const [tools, setTools] = useState<AgentToolProgress[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [interrupted, setInterrupted] = useState(false);
  const [following, setFollowing] = useState(true);
  const controller = useRef<AbortController | null>(null);
  const sequence = useRef(0);
  const conversation = useRef<HTMLDivElement | null>(null);
  const conversationContent = useRef<HTMLDivElement | null>(null);
  const followLatest = useRef(true);
  const reset = () => {
    imageController.current?.abort();
    imageController.current = null;
    setAttachments([]);
    setPendingImages([]);
    setImageLoading(false);
    setImageError(null);
    setHistory([]);
    setDraft("");
    setPendingUser("");
    setPartial("");
    setThinking("");
    setTools([]);
    setError(null);
    setInterrupted(false);
    followLatest.current = true;
    setFollowing(true);
  };
  const close = () => {
    controller.current?.abort();
    controller.current = null;
    setOpen(false);
    setBusy(false);
    reset();
  };
  useEffect(
    () => () => {
      controller.current?.abort();
      imageController.current?.abort();
    },
    []
  );
  useEffect(() => {
    if (!open) return;
    const request = new AbortController();
    controller.current = request;
    setConfigured(null);
    setError(null);
    void getAISettings(request.signal)
      .then((settings) => {
        if (!request.signal.aborted) {
          setConfigured(settings.has_api_key);
          setSupportsImages(Boolean(settings.supports_images));
        }
        return settings;
      })
      .catch((requestError: unknown) => {
        if (!request.signal.aborted) {
          setConfigured(false);
          setError(requestError instanceof Error ? requestError.message : "");
        }
      });
    return () => request.abort();
  }, [open]);
  useEffect(() => {
    if (!open || !configured || !conversationContent.current) return;
    const resize = new ResizeObserver(() => {
      if (followLatest.current && conversation.current)
        conversation.current.scrollTop = conversation.current.scrollHeight;
    });
    resize.observe(conversationContent.current);
    const container = conversation.current;
    const onToggle = (event: Event) => {
      if (event.target instanceof HTMLDetailsElement && event.target.open) {
        followLatest.current = false;
        setFollowing(false);
      }
    };
    container?.addEventListener("toggle", onToggle, true);
    return () => {
      resize.disconnect();
      container?.removeEventListener("toggle", onToggle, true);
    };
  }, [open, configured]);
  const workItems = useMemo(
    () =>
      collectAgentWorkItems([...history.flatMap((message) => message.tools ?? []), ...tools]).flatMap((item) =>
        item.identifier
          ? [{ identifier: item.identifier, title: item.name, href: agentWorkItemHref(workspaceSlug, item) }]
          : []
      ),
    [history, tools, workspaceSlug]
  );

  const addImages = async (files: File[]) => {
    if (!files.length || busy || imageLoading || imageController.current || interrupted) return;
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
    imageController.current = request;
    setImageLoading(true);
    try {
      const images = await Promise.all(files.map((file) => readAgentImage(file, request.signal)));
      if (!request.signal.aborted) setAttachments((current) => [...current, ...images]);
    } catch {
      if (!request.signal.aborted) setImageError(t("account_settings.ai.image_invalid"));
    } finally {
      if (imageController.current === request) {
        imageController.current = null;
        setImageLoading(false);
      }
    }
  };
  const sendEnabled = canSendAgentMessage(
    draft,
    busy || imageLoading,
    configured,
    interrupted,
    supportsImages ? attachments.length : 0
  );
  const send = async () => {
    if (!sendEnabled || imageController.current) return;
    const content = draft.trim();
    const request = new AbortController();
    controller.current = request;
    // UI-only reasoning and tool details are not sent back as model history.
    const messages: AgentMessage[] = history.flatMap((message) => {
      const answer = message.role === "assistant" ? agentAnswerContent(message.content) : message.content;
      return answer.trim() || message.images?.length
        ? [{ role: message.role, content: answer, ...(message.images?.length ? { images: message.images } : {}) }]
        : [];
    });
    const sentImages = attachments;
    messages.push({ role: "user", content, ...(sentImages.length ? { images: sentImages } : {}) });
    setPendingImages(sentImages);
    setAttachments([]);
    setImageError(null);
    setBusy(true);
    setError(null);
    setDraft("");
    setPendingUser(content);
    setPartial("");
    setThinking("");
    setTools([]);
    followLatest.current = true;
    setFollowing(true);
    let text = "";
    let modelThinking = "";
    let turnTools: AgentToolProgress[] = [];
    try {
      const body = await startAgentChat(workspaceSlug, messages, projectId, request.signal);
      await readAgentStream(
        body,
        (event) => {
          if (request.signal.aborted) return;
          if (event.type === "text") {
            text += event.text;
            setPartial(text);
          }
          if (event.type === "thinking") {
            modelThinking += event.text;
            setThinking(modelThinking);
          }
          if (event.type === "tool") {
            turnTools = updateAgentTools(turnTools, event);
            setTools(turnTools);
          }
        },
        request.signal
      );
      request.signal.throwIfAborted();
      if (!agentAnswerContent(text).trim()) throw new Error(t("account_settings.ai.empty_response"));
      setHistory([
        ...history,
        { id: ++sequence.current, role: "user", content, ...(sentImages.length ? { images: sentImages } : {}) },
        { id: ++sequence.current, role: "assistant", content: text, thinking: modelThinking, tools: turnTools },
      ]);
      setPartial("");
      setThinking("");
      setTools([]);
      setPendingUser("");
      setPendingImages([]);
    } catch (requestError: unknown) {
      if (controller.current === request) {
        setInterrupted(true);
        setError(
          request.signal.aborted
            ? t("account_settings.ai.cancelled")
            : requestError instanceof Error
              ? requestError.message
              : ""
        );
      }
    } finally {
      if (controller.current === request) {
        setBusy(false);
        controller.current = null;
      }
    }
  };
  const configure = () => {
    close();
    toggleProfileSettingsModal({ isOpen: true, activeTab: "ai" });
  };
  const scrollToLatest = () => {
    followLatest.current = true;
    setFollowing(true);
    if (conversation.current) conversation.current.scrollTop = conversation.current.scrollHeight;
  };
  return (
    <>
      <button
        type="button"
        aria-label={t("account_settings.ai.title")}
        title={t("account_settings.ai.title")}
        className="flex h-8 items-center justify-center gap-1 rounded-md px-2 text-body-xs-medium hover:bg-layer-1-hover"
        onClick={() => setOpen(true)}
      >
        <Sparkles className="size-4" />
        <span>AI</span>
      </button>
      <Dialog open={open} onClose={close} className="fixed inset-0 z-[100]">
        <div className="fixed inset-0 bg-black/30" aria-hidden="true" />
        <div className="fixed inset-0 flex items-center justify-center p-4">
          <Dialog.Panel className="agent-chat-panel flex max-h-[85vh] w-full max-w-2xl min-w-0 flex-col gap-4 rounded-xl bg-surface-1 p-5 shadow-raised-200">
            <div className="flex shrink-0 items-center justify-between">
              <Dialog.Title className="text-h5-medium">{t("account_settings.ai.title")}</Dialog.Title>
              <button type="button" aria-label={t("account_settings.ai.close")} onClick={close}>
                <X className="size-5" />
              </button>
            </div>
            <Dialog.Description className="agent-chat-description text-body-sm-regular text-secondary">
              {t("account_settings.ai.chat_description")}
            </Dialog.Description>
            <p className="shrink-0 text-body-xs-regular text-secondary">{workspaceSlug}</p>
            {configured === null ? (
              <p role="status">{t("account_settings.ai.loading")}</p>
            ) : !configured ? (
              <Button onClick={configure}>{t("account_settings.ai.configure")}</Button>
            ) : (
              <>
                <div
                  ref={conversation}
                  className="agent-conversation min-h-20 min-w-0 flex-1 overflow-y-auto"
                  aria-label={t("account_settings.ai.conversation")}
                  onScroll={(event) => {
                    const element = event.currentTarget;
                    const nearBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 64;
                    followLatest.current = nearBottom;
                    setFollowing(nearBottom);
                  }}
                >
                  <div ref={conversationContent} className="min-w-0 space-y-4">
                    {history.map((message) => (
                      <div key={message.id} className="agent-chat-message min-w-0 rounded-lg bg-layer-1 p-3">
                        <p className="mb-1 text-body-xs-medium">
                          {t(message.role === "user" ? "account_settings.ai.you" : "account_settings.ai.title")}
                        </p>
                        {message.role === "assistant" ? (
                          <>
                            <AgentMessageContent
                              content={message.content}
                              thinking={message.thinking}
                              workItems={workItems}
                            />
                            <AgentToolDetails tools={message.tools ?? []} workspaceSlug={workspaceSlug} />
                          </>
                        ) : (
                          <>
                            <ChatMarkdown content={message.content} labels={markdownLabels} />
                            <AgentImagePreviews images={message.images} />
                          </>
                        )}
                      </div>
                    ))}
                    {(pendingUser || pendingImages.length > 0) && (
                      <div className="agent-chat-message min-w-0 rounded-lg bg-layer-1 p-3">
                        <p className="mb-1 text-body-xs-medium">
                          {t(interrupted ? "account_settings.ai.interrupted_request" : "account_settings.ai.you")}
                        </p>
                        <ChatMarkdown content={pendingUser} labels={markdownLabels} />
                        <AgentImagePreviews images={pendingImages} />
                      </div>
                    )}
                    {(partial || thinking || tools.length > 0 || busy) && (
                      <div className="agent-chat-message min-w-0 rounded-lg bg-layer-1 p-3">
                        <p className="mb-1 text-body-xs-medium">{t("account_settings.ai.title")}</p>
                        <AgentMessageContent
                          content={partial}
                          thinking={thinking}
                          streaming={busy}
                          workItems={workItems}
                        />
                        <AgentToolDetails tools={tools} workspaceSlug={workspaceSlug} />
                        {busy && !partial && !thinking && tools.length === 0 && (
                          <p role="status" className="text-body-xs-regular text-secondary">
                            {t("account_settings.ai.receiving")}
                          </p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {!following && (
                  <button
                    type="button"
                    onClick={scrollToLatest}
                    className="flex shrink-0 items-center justify-center gap-1 text-body-xs-regular text-accent-primary"
                  >
                    <ArrowDown className="size-3" />
                    {t("account_settings.ai.scroll_latest")}
                  </button>
                )}
                <form
                  className="agent-chat-composer flex shrink-0 flex-col gap-3"
                  onDragOver={(event) => {
                    if (event.dataTransfer.types.includes("Files")) event.preventDefault();
                  }}
                  onDrop={(event) => {
                    if (!event.dataTransfer.files.length) return;
                    event.preventDefault();
                    void addImages(Array.from(event.dataTransfer.files));
                  }}
                  onSubmit={(event) => {
                    event.preventDefault();
                    void send();
                  }}
                >
                  <AgentImagePreviews
                    images={attachments}
                    onRemove={(index) =>
                      setAttachments((current) => current.filter((_image, position) => position !== index))
                    }
                  />
                  <input
                    ref={imagePicker}
                    type="file"
                    accept="image/png,image/jpeg,image/webp"
                    multiple
                    className="hidden"
                    aria-label={t("account_settings.ai.image_add")}
                    disabled={!supportsImages || busy || imageLoading || interrupted}
                    onChange={(event) => {
                      const files = Array.from(event.currentTarget.files ?? []);
                      event.currentTarget.value = "";
                      void addImages(files);
                    }}
                  />
                  <textarea
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
                    className="min-h-24 w-full resize-y rounded border border-subtle bg-surface-1 p-3"
                    aria-label={t("account_settings.ai.message")}
                    aria-describedby={interrupted ? "ai-interrupted-guidance" : undefined}
                    placeholder={t("account_settings.ai.message")}
                    value={draft}
                    disabled={busy}
                    onChange={(event) => setDraft(event.target.value)}
                  />
                  {imageLoading && (
                    <p role="status" className="text-body-xs-regular text-secondary">
                      {t("account_settings.ai.image_uploading")}
                    </p>
                  )}
                  {imageError && (
                    <p role="alert" className="text-body-xs-regular text-danger-primary">
                      {imageError}
                    </p>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button type="submit" disabled={!sendEnabled}>
                      {t("account_settings.ai.send")}
                    </Button>
                    {busy && (
                      <Button variant="secondary" onClick={() => controller.current?.abort()}>
                        {t("account_settings.ai.cancel")}
                      </Button>
                    )}
                    <Button
                      variant="secondary"
                      onClick={() => imagePicker.current?.click()}
                      disabled={!supportsImages || busy || imageLoading || interrupted}
                      title={!supportsImages ? t("account_settings.ai.image_vision_required") : undefined}
                    >
                      <ImagePlus className="size-4" />
                      {t("account_settings.ai.image_add")}
                    </Button>
                    <Button variant="secondary" disabled={busy} onClick={reset}>
                      {t("account_settings.ai.clear")}
                    </Button>
                    <Button variant="secondary" disabled={busy} onClick={configure}>
                      {t("account_settings.ai.configure")}
                    </Button>
                  </div>
                </form>
              </>
            )}
            {error !== null && (
              <div role="alert" className="agent-chat-error text-body-sm-regular text-danger-primary">
                {error && <p>{error}</p>}
                <p id={interrupted ? "ai-interrupted-guidance" : undefined}>
                  {t(interrupted ? "account_settings.ai.interrupted_guidance" : "account_settings.ai.error")}
                </p>
              </div>
            )}
          </Dialog.Panel>
        </div>
      </Dialog>
    </>
  );
}
