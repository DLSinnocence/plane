# Browser regressions

From the repository root:

```sh
pnpm install --frozen-lockfile
pnpm turbo run build --filter='web^...'
pnpm --filter web exec playwright install chromium
pnpm --filter web test:browser
```

Playwright starts and stops a local Vite fixture server. The fixtures import the production dropdowns, shared UI components, actual modal, and settings sidebar. Only data hooks, translations, and navigation adapters use deterministic fixtures; Headless UI, Popper, DOM measurements, focus, and pointer events run in Chromium.

The suite checks dropdown coordinates, option selection, timezone search/reopening, Escape, modal scrolling and resizing, invalid nested trigger markup, and administrator-only visibility of the integration link alongside Webhooks. Integration page tests load the real `app/routes.ts` graph, render the actual Feishu configuration page and catch-all page, then exercise link clicks, direct URLs, and refreshes with mocked read-only API responses. Unrelated application shells and pages are placeholders; integration route registration is never mocked. No API server, credentials, or real workspace mutations are required.

Popper's element ref, styles, and placement attributes belong on `Combobox.Options` itself. A single inner child is wrapped by Headless UI's `Frozen` component, which can replace that child's ref and leave Popper uninitialized at `(0, 0)`. These searchable popup controls use `modal={false}` because the search input lives inside the popup; default modal handling otherwise marks its option-list siblings inert. The containing work-item dialog continues to manage its own modality.

## Invitation authentication regressions

Run the focused suite with `pnpm --filter web test:browser invitation-auth.spec.ts --workers=1`.

The route-backed fixture maps `/workspace-invitations` to the actual `WorkspaceInvitationPage`. Its real `AuthenticationWrapper`, `InvitationService`, and `APIService` run unchanged. Fixture adapters use React Router's real location, search and navigation so a token-bearing invitation redirects through the normal `/` or `/sign-up` routes and survives full reloads.

The login form is explicitly labelled **Simulated session login**. It only updates fixture session state and restores a mocked `/api/users/me/` response; it does not authenticate against live SSO, register real users, send email, or send messages. User, profile, settings and workspace stores are deterministic fixture data. Tests model asynchronous restoration, anonymous 401/error-shaped data without a valid user ID, matching/wrong email, and a new user with no completed workspace onboarding. All API requests are intercepted, and unexpected requests fail the test.

Coverage includes exact encoded `next_path` with token and project ID, no invitation detail GET before login, returning after simulated login/signup, direct new-user acceptance without forced workspace creation, exact acceptance POST body and target navigation, workspace/settings refresh after acceptance, malformed/missing/expired links, wrong-email refusal, and 401 during acceptance preserving the invitation return URL. Every case asserts there are no browser `pageerror` events. These checks establish the client-side flow with a simulated session, **not full live SSO verification**.

## Actual login-language regressions

`auth-language.spec.ts` uses a second local Vite fixture configured by `language.vite.config.ts`. It loads the real `AuthBase`, login/signup forms, OAuth controls, i18next singleton, `TranslationProvider`, and locale JSON resources. Translations are not mocked in this fixture. Instance configuration and email-check/CSRF responses are synthetic; no real authentication or mail is performed.

A fresh browser with an English browser locale must show Chinese login/signup controls and Chinese document metadata. Tests also verify that upstream welcome text, marketing claims, customer logos and Plane-hosted legal links are absent, login/signup switching and email correction preserve the invitation return path, and an explicitly chosen English preference survives reload.

`pnpm --filter web check:types` also typechecks the fixtures in their own TypeScript project because they import UI source files from a sibling workspace package. Playwright reports and traces are ignored by Git.
