# Feishu application bot notifications

Plane workspace administrators can configure Feishu under **Workspace settings → Integrations → Feishu**. This panel works independently of the legacy integrations catalog and does not require a commercial feature flag.

The integration sends interactive cards as direct messages from a Feishu application bot for work item field changes, comments, and related activities. Reassignment and state handoffs include the old and new assignees as recipients. Changes to the state-assignees map also notify the previous and new owners of the affected states. The person making the change receives a card too when they are among the responsible recipients; being the actor does not exclude them. Recipients need an active Plane workspace membership and active membership in the work item's project. Plane identifies their Feishu account automatically using only the mobile synced from SSO. Missing, invalid, or unmatched mobile numbers cause the notification to be skipped with a reason in delivery history. Cards link to work item details, which still require Plane access permission.

## Configure the Feishu application

1. In the [Feishu developer console](https://open.feishu.cn/app), create an enterprise self-built/custom application and enable its **Bot** capability. This integration uses an application bot, not a custom group webhook bot.
2. Request **Send messages as an app** (`im:message:send_as_bot`). The [official Send message API documentation](https://open.feishu.cn/document/server-docs/im-v1/message/create) confirms this permission.
3. Request **Obtain user ID via email or mobile number** (`contact:user.id:readonly`) for automatic mobile lookup. The [official batch_get_id documentation](https://open.feishu.cn/document/server-docs/contact-v3/user/batch_get_id) describes obtaining an application's `open_id` from a mobile number or email. Plane uses the mobile number.
4. Configure the application's contact data permissions and availability/visibility range for all intended recipients. For organization-wide notifications, grant the full intended organization's contact access and application visibility. A messaging scope alone does not grant contact lookup access, and a valid ID alone does not make a recipient reachable by the bot.
5. Create and publish a new application version and complete tenant approval. Bot capability, scope changes, and visibility must be effective in the published application.
6. Copy **App ID** and **App Secret** from the application's credentials page. Treat the secret as a credential; do not paste it into issues, screenshots, or delivery reports.

## Sync SSO mobile numbers

MeowAliveOIDC synchronizes the account's mobile number during SSO login from the standard `phone_number` claim or Casdoor's `phone` and `phoneCountryCode` claims. Configure your identity provider to supply the member's actual Feishu account mobile number. After deploying phone synchronization or correcting claims, members must **sign out and sign in again through SSO** to update their Plane account; an already-open session does not perform the new synchronization.

The login requests the OIDC `phone` scope. The authenticated UserInfo phone is authoritative; only verified ID-token phone claims are used when UserInfo omits the phone. Explicit phone-verification flags must be `true`; when absent, the configured SSO issuer is trusted. Missing, malformed, or explicitly unverified phone data clears the previously stored number on login, preventing delivery to a stale identity.

Use consistent country normalization: mainland China numbers may be entered as an 11-digit mobile number or with `+86`; international numbers must include their `+` country/region code. When using Casdoor's separate fields, set `phoneCountryCode` consistently with `phone`. Feishu's lookup documentation requires the international prefix for numbers outside mainland China. Invalid, ambiguous, conflicting, or changed phone identities are reported in delivery history; correct the SSO identity before retrying.

The admin **Account identification** section displays active member names and a masked SSO mobile hint (or a missing-mobile label). It does not expose full phone numbers. A listed mobile indicates that an identity is available to try; it does not confirm a successful Feishu match or delivery.

## Configure Plane

1. Open **Workspace settings → Integrations → Feishu** as a workspace administrator.
2. Enter the App ID and App Secret, enable notifications, and save. Plane never returns the saved secret to the browser. On later edits, leave the password field blank to retain it; the placeholder is not a secret value.
3. Review **Account identification**. Plane resolves each recipient automatically from their SSO mobile using the configured Feishu application's contact lookup. Use **Refresh** after members re-login through SSO.
4. To validate deliberately, click **Send test card** beside a member with an SSO mobile. This queues a real direct message and does not require that the member be assigned to a work item. The queued confirmation is not proof of delivery. Refresh recent deliveries and confirm receipt in Feishu.

When changing App ID, enter the new application's secret before enabling it and configure its lookup permissions and visibility. Recipient lookup runs in the context of the configured application; recipients resolved for the previous application must not be reused. Queued notifications tied to a changed application are skipped with an application-changed reason. Save pending configuration edits before sending tests.

## Deployment requirements

- Apply the new API database migrations before starting the updated services.
- Run the API, its queue/broker, and a **Celery worker** consuming notification tasks. A working settings page alone does not deliver queued cards. Keep **Celery Beat** running to recover pending records or expired worker leases every two minutes. Transient Feishu failures retry up to four attempts per recipient; delivered records are not sent again.
- Configure the public **`APP_BASE_URL` / `WEB_URL`** consistently with the externally reachable Plane origin. Card links must open for recipients using Feishu; container hostnames and `localhost` will not work for other users. Ensure the backend receives the public URL variable used by your deployment.
- Allow outbound HTTPS from the worker to Feishu Open Platform for application tokens, contact lookup, and message delivery.
- Recent deliveries shows at most the latest 50 records with localized status and safe error labels. The UI does not poll; use **Refresh** to update it.

If delivery fails, check the app secret, published bot and permission scopes, contact data access, full intended recipient visibility, SSO phone synchronization and country code, and worker task consumption. Missing, invalid, or unmatched phones skip sending with a reason; correct the SSO claims or Feishu account phone and have the member sign in again through SSO. If lookup finds no account, also check the application's contact permissions and visibility. Ambiguous or conflicting phone identities must be resolved before sending. Check history and worker logs without disclosing credentials or full phone numbers. If card links fail, check the public Plane origin and recipient permissions.

## Verification limits

The frontend's configuration validation and safe label fallback have local automated tests. No live Feishu delivery or mobile lookup was verified during implementation: no application credentials were available, and no test messages were sent. Complete the explicit test-card procedure in your own tenant before relying on notifications.
