# Models.dev metadata

`models_dev.json` is a normalized offline snapshot of <https://models.dev/api.json>,
the dataset used by OpenCode: <https://opencode.ai/docs/models/>. The upstream
project is <https://github.com/anomalyco/models.dev>; its MIT license is preserved
in `models_dev.LICENSE`. The snapshot records the SHA-256 of the source response.

Regenerate from the repository root with:

```sh
python3 apps/api/scripts/refresh_models_dev.py
```

The refresh script uses only Python's standard library, a 30-second HTTP timeout,
a 16 MiB source limit and a 2 MiB normalized output limit. Its sole HTTP request
contains no Plane settings, credentials, or gateway URLs. It deterministically
sorts the JSON; a refresh intentionally follows the current upstream dataset.
The committed snapshot has 213 providers and 7,798 provider/model entries in
544,990 bytes, reduced from the 4,649,535-byte source response.

Only provider IDs, provider API URLs, exact model IDs and display names are retained.
Each model stores `[vision, tools, reasoning, context_window, name]`, derived from the exact fields:

- `modalities.input`: `image` membership (not `attachment`, which can mean PDF).
- `tool_call`: boolean.
- `reasoning`: boolean.
- `limit.context`: positive integer.
- `name`: display name, falling back to the model ID.

Persisted selections can call
`plane.utils.ai_models.lookup_model_metadata(provider, base_url, model_id)` without
upstream discovery. It returns `name`, the four capability fields, and
`metadata_source: "models.dev"`, or `None` for unknown/unset models. Display-name
differences between otherwise identical aliases fall back to the requested ID.

Missing or invalid values remain null. Cost, credentials/environment variable
names, descriptions, and other unrelated fields are omitted. There is no runtime
metadata HTTP request; a missing/corrupt snapshot falls back to explicit upstream
metadata, then custom/unknown. Chat does not load this registry.

Matching priority is the API origin's provider, an explicit provider/model ID,
exact IDs from native publishers, then globally identical exact-ID metadata.
Scheme, hostname, and effective port identify an origin; URL paths are ignored.
SDK-native providers without an `api` field have explicit origin defaults in
`ai_model_metadata.py`. The protocol argument `openai` is never a vendor hint.
Examples that resolve on custom gateways include `gpt-4o`, `gpt-4.1`,
`openai/gpt-4o`, `anthropic/claude-sonnet-4-5`, `google/gemini-2.5-pro`, and
`my-gateway/anthropic/claude-sonnet-4-5` (one gateway prefix wrapping an explicit
provider namespace). Original IDs are preserved for chat selection.

Matching is case-sensitive. Arbitrary bare suffix matching, date removal,
punctuation rewriting, revision removal, `:free`/`:thinking` removal, and fuzzy
name matching are deliberately unsupported. An exact variant present in the
registry remains valid. Conflicting unqualified aliases are unresolved rather
than selected by provider order. Known entries prefer non-null registry fields
over upstream claims; missing registry fields can use explicit upstream values.
`metadata_source` is `models.dev` for a matched entry, `provider` for explicit
upstream evidence, and `custom` otherwise. A custom model remains available for
manual capability overrides in the UI.
