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

`pnpm --filter web check:types` also typechecks the fixtures in their own TypeScript project because they import UI source files from a sibling workspace package. Playwright reports and traces are ignored by Git.
