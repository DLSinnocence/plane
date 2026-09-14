/** Copyright (c) 2023-present Plane Software, Inc. and contributors
 * SPDX-License-Identifier: AGPL-3.0-only */
import { makeAutoObservable } from "mobx";

export const aiFixtureEnabled = () => new URLSearchParams(window.location.search).has("ai-assistant");
export const aiFixtureState = makeAutoObservable({
  profileSettingsModal: { isOpen: false, activeTab: null as string | null },
  user: { data: { id: "ai-user", display_name: "AI fixture user" } },
  toggleProfileSettingsModal(options: { isOpen?: boolean; activeTab?: string | null }) {
    Object.assign(this.profileSettingsModal, options);
  },
  switchUser() {
    this.user.data.id = this.user.data.id === "ai-user" ? "other-user" : "ai-user";
  },
});
export const useCommandPalette = () => ({
  profileSettingsModal: aiFixtureState.profileSettingsModal,
  toggleProfileSettingsModal: (options: { isOpen?: boolean; activeTab?: string | null }) =>
    aiFixtureState.toggleProfileSettingsModal(options),
});

type CapturedChat = { url: string; body: unknown; credentials?: RequestCredentials; csrf: string | null };
declare global {
  interface Window {
    aiFixture: {
      requests: CapturedChat[];
      aborted: number;
      push: (text: string) => void;
      finish: () => void;
      navigate: (path: string) => void;
      switchUser: () => void;
    };
  }
}

if (aiFixtureEnabled()) {
  // Controlled transport only: production service, parser, React state and dialog still execute.
  const nativeFetch = window.fetch.bind(window);
  let active: ReadableStreamDefaultController<Uint8Array> | undefined;
  window.aiFixture = {
    requests: [],
    aborted: 0,
    push: (text) => active?.enqueue(new TextEncoder().encode(text)),
    finish: () => {
      active?.close();
      active = undefined;
    },
    navigate: () => undefined,
    switchUser: () => aiFixtureState.switchUser(),
  };
  window.fetch = async (input, init) => {
    const url = String(input);
    if (!new URL(url, window.location.origin).pathname.endsWith("/agent/chat/")) return nativeFetch(input, init);
    window.aiFixture.requests.push({
      url,
      body: JSON.parse(String(init?.body)),
      credentials: init?.credentials,
      csrf: new Headers(init?.headers).get("X-CSRFToken"),
    });
    const signal = init?.signal;
    signal?.throwIfAborted();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        active = controller;
        signal?.addEventListener(
          "abort",
          () => {
            window.aiFixture.aborted += 1;
            if (active === controller) active = undefined;
            try {
              controller.error(new DOMException("Fixture request aborted", "AbortError"));
            } catch {
              /* Already cancelled by the reader. */
            }
          },
          { once: true }
        );
      },
      cancel() {
        active = undefined;
      },
    });
    return new Response(body, { headers: { "Content-Type": "application/x-ndjson" } });
  };
}
