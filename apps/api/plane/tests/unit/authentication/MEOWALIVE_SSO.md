# MeowAlive SSO mobile synchronization

MeowAlive authorization requests `openid profile email phone`. Configure the
Casdoor application to expose a user's mobile through standard OIDC
`phone_number` or Casdoor `phone` and `phoneCountryCode` claims.

Every successful MeowAlive login updates `User.mobile_number`, including signup
and returning users, independently of name/avatar profile sync. A present
`phone_number` takes precedence over `phone`, even when empty or malformed.
UserInfo phone claims take precedence over ID-token claims. Only when UserInfo
omits both phone fields may phone claims fall back to the RS256-verified ID
token, after issuer, audience, nonce and matching UserInfo subject checks.
No other profile fields are supplemented by this phone fallback.

An explicit `phone_number_verified` or `phoneVerified` must be JSON boolean
`true`; false or malformed flags prevent phone use. When falling back to a token
phone, a verification denial from either source prevents use. If the flags are
absent, Plane trusts the configured SSO issuer's authenticated phone assertion;
operators must ensure that issuer maintains trustworthy mobile ownership.
The existing requirement for an explicitly verified email remains unchanged.

Missing, empty, malformed or unverified phone data clears the previous stored
mobile on the next successful MeowAlive login. This deliberately prevents stale
SSO numbers from remaining notification recipients. Changes upstream are applied
at login, not pushed between logins; no historical-user backfill is performed.

`plane.utils.phone.normalize_phone_number(value, country_code=None)` returns
normalized E.164-shaped text or `''`. It removes whitespace, hyphens and
parentheses; rejects letters, extensions, other punctuation and non-string phone
values; and accepts explicit `+`/`00` international numbers with 8–15 ASCII
digits and a nonzero initial digit. Unprefixed mainland mobile numbers matching
`1[3-9]` plus nine digits default to `+86`. Casdoor hints `86`, `+86`, and `CN`
are accepted. Other country hints require an explicit international number;
unknown countries are never inferred. Formatting does not establish allocation
or ownership of a number.

Focused tests (run from `apps/api` in the configured Django test environment):

```sh
pytest plane/tests/unit/authentication/test_meowalive_phone.py plane/tests/unit/authentication/test_meowalive_oidc.py plane/tests/unit/authentication/test_meowalive_views.py
```
