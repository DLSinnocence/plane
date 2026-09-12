# Invitations

An invited email address does **not** need an existing Plane account. Creating an invitation saves a pending record; it does not create a user or add workspace/project membership. An anonymous visitor following the link is automatically sent to the normal sign-in page, with the full invitation URL preserved as `next_path`. After signing in or registering (including the instance's configured SSO), they return to the invitation and explicitly accept using the invited email address. Invitation details are not fetched until authentication is confirmed.

New users can accept an invitation before completing workspace onboarding. Once they accept, Plane refreshes their joined workspaces and settings; any remaining profile/onboarding steps occur when entering the workspace, preserving that destination.

## Without an email service

SMTP is optional for creating invitations. When `EMAIL_HOST` is blank in the instance email configuration, creation succeeds with `email_status: "not_configured"`. No mail task is submitted. The members screen and onboarding show **Invitations created**, explain that email is not configured, and offer a copy button and selectable link for each saved invitation. The existing pending invitations menu also supports **Copy link**.

Share each private link only with its intended recipient. Links contain acceptance tokens. Possessing a link alone does not grant membership: the backend requires an authenticated account whose email matches the invitation. An unverified account can accept with the private token; discovering and accepting invitations through the tokenless account invitation list requires verified email. This keeps password signup usable without SMTP while preventing accounts registered with someone else's email from discovering their tokens.

This does not turn off email verification or bypass SSO. Login, signup, and SSO still obey instance authentication settings. If the instance requires a mailed login code, configure SMTP or use its configured SSO/password options; invitation creation does not provide an alternative authentication mechanism.

## Configure email delivery

Plane includes SMTP client support, but does not supply a ready-to-use mailbox or SMTP server. An instance administrator can configure and test an existing mail service in **God Mode → Email** (normally `/god-mode/email/`). Set the SMTP host, port, sender address, and any required username/password, then choose the TLS/SSL mode required by the provider.

The corresponding configuration keys are `EMAIL_HOST`, `EMAIL_PORT`, `EMAIL_HOST_USER`, `EMAIL_HOST_PASSWORD`, `EMAIL_FROM`, `EMAIL_USE_TLS`, and `EMAIL_USE_SSL`. The API and Celery worker must use the same instance configuration/environment. Mail delivery requires the broker and worker; a `queued` response confirms task submission, not mailbox delivery. When SMTP is absent, copy-link invitations remain available and do not require a mail-origin URL.

## API behavior

App workspace/project creation responses retain HTTP 200 and `message`, adding:

```json
{
  "message": "Invitations created successfully",
  "email_status": "not_configured",
  "invitations": [
    {
      "id": "persisted-id",
      "email": "person@example.com",
      "role": 15,
      "invite_link": "/workspace-invitations/?invitation_id=...&slug=...&token=..."
    }
  ]
}
```

External workspace API creation retains HTTP 201 and the original top-level invitation fields, with the same additional metadata. The authorized response uses saved database objects, including their real IDs and tokens.

| Status           | Meaning                                                                                                                                                                                              |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `not_configured` | No SMTP host; invitation is saved and no email is queued.                                                                                                                                            |
| `queued`         | Mail tasks were accepted by the broker after the database commit. This is not a delivery receipt.                                                                                                    |
| `failed`         | Reading email configuration or queuing at least one task failed. The saved invitations and links remain usable. For mixed batches, per-invitation `email_status` identifies queued and failed items. |
| `pending`        | An enclosing transaction has not committed yet. Dispatch runs only after commit; this response does not claim queuing or delivery.                                                                   |

Mail workers also skip transport if SMTP is absent when they execute. SMTP delivery failures after successful queuing are logged by the worker; creation responses cannot report later delivery results. Configure and test SMTP in instance administration separately.

Email input is trimmed, lowercased and deduplicated before queries. Workspace/project roles are limited to Guest (5), Member (15), and Admin (20), with existing inviter/workspace role restrictions. A duplicate pending invite returns the existing ID, role, and token; use the existing invitation role editor for role changes. Conflicting roles for duplicate emails in one request are rejected. Reinviting a previously declined invitation resets it with a new token. Project creation is scoped to its workspace and no longer accesses a queryset as a member or invokes a task on an invitation list.

## Routes and security

The declared React Router route is `/workspace-invitations` in `apps/web/app/routes/core.ts`. Workspace links use `invitation_id`, `slug`, and `token`; project links additionally use `project_id` on the same page. Project links must not target the undeclared `/project-invitations` path. Sign-in and signup links carry the complete invitation URL as an encoded `next_path`. Authenticated users return directly to invitations, including users who have not yet completed onboarding. If authentication is required again, API and page redirects retain the original query, including the acceptance token. Other protected pages preserve their destination through any remaining onboarding steps. Validation reuses `isValidNextPath` and rejects external, scheme-relative, backslash, and control-character destinations. Without a valid return path, existing onboarding/workspace defaults remain unchanged.

Public invitation details exclude `token`, `invite_link`, and the email `message` (which can contain a token-bearing link). Authorized invitation management returns copyable links. The accept endpoints require a boolean `accepted` value, the exact saved token, an authenticated user, and matching email. Project membership updates are scoped to the invited project.

## Validation

API regression tests: `apps/api/plane/tests/contract/api/test_invitations.py`. Coverage includes unknown emails without SMTP, validation, normalization/deduplication, stable tokens, after-commit dispatch, broker failures, external API creation, public token privacy, and anonymous/wrong/matching-email acceptance. Mail dispatch is mocked; these tests never send real mail.

Frontend helper tests: `node --experimental-strip-types --test apps/web/helpers/invitations.helper.test.mjs apps/web/helpers/authentication-redirect.test.mjs`. Redirect tests cover complete workspace/project invitation query preservation through sign-in and onboarding, invalid destination rejection, and unchanged default paths.
