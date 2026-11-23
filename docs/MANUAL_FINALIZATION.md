# Remaining setup and test steps

The current source implementation is still being completed. Do not use an APK from an earlier pass for feature testing: it predates the current native service and safety-flow changes. The final arm64 APK will be built only after source work is complete, then installed on the Honor X5c for the agreed device checks. Do not use real emergency contacts or invoke evidence cleanup against production data during testing.

## Evidence retention/access update (apply before testing this feature)

1. In Supabase Dashboard → **SQL Editor**, open and review `supabase/migrations/202611220002_evidence_retention_and_access.sql`, then run it once. It adds account retention choices and recording timestamps, and changes authenticated Storage reads to require a non-expired evidence row plus journey authorization. Do not run the cleanup worker manually against production data.
2. Regenerate the Dashboard bundles from the project directory with `node scripts/prepare-supabase-dashboard-functions.mjs`.
3. Deploy the generated `register-evidence`, `get-evidence-download-url`, and `cleanup-expired-evidence` files from `tmp/supabase-dashboard-functions/` through Dashboard → **Edge Functions**. Keep JWT verification enabled for the two user-facing functions. The cleanup function has a service-role bearer check; invoke it only from the existing scheduled job.
4. The app's Settings → emergency evidence section lets the owner choose 7, 30, or 90 days. Until the migration is applied, the selection is saved locally and account synchronization will report pending. Once deployed, test with disposable accounts and evidence: verify capture timestamp, chosen expiry, owner and explicitly shared viewer access, denial after expiry, deletion, and the scheduled cleanup run. Do not use real contacts or real sensitive recordings for the test.

Android limits: video requires the app foregrounded, the device unlocked, camera permission, and an available camera. Background/locked camera recording is not promised. Audio recording is an opt-in, time-limited attempt and depends on Android allowing the microphone foreground service to continue. Any recording failure is reported separately; emergency alert and location behavior continues.

## Family dashboard source update

The responsive dashboard source is in `dashboard/`; it uses Supabase Auth, the signed-in user's RLS-filtered journey query, Supabase Realtime, Leaflet maps, and the authenticated `get-evidence-download-url` function. It contains no seeded journeys. After source changes, run `npm run dashboard:build`, then commit and push the source so the connected Cloudflare Pages project can publish it. Keep `dashboard/config.js` out of Git; configure only the Supabase URL and publishable key in Cloudflare Pages variables. Validate with two disposable accounts: owner grants a journey, contact signs in and opens the shared ID, then revoke access and confirm refresh denies the journey. Verify offline/stale display, route/emergency event history, authorized evidence, and notification attempt rows. RLS and deployed policy behavior still require remote testing.

## Google OAuth setup

The mobile sign-up and sign-in screens now use Supabase OAuth with Google. Before testing, configure the provider once:

1. In Google Cloud Console, create an OAuth client for a **Web application**. Copy its client ID and client secret.
2. In Supabase Dashboard → **Authentication** → **Sign In / Providers** → **Google**, enable Google, paste the client ID and client secret, and save.
3. In that Google OAuth client, add the exact **Callback URL** displayed by Supabase's Google provider settings as an authorized redirect URI. It usually has the form `https://<project-ref>.supabase.co/auth/v1/callback`; use the dashboard's displayed value, not a guessed one.
4. In Supabase Dashboard → **Authentication** → **URL Configuration** → **Redirect URLs**, allow `companion-safety://auth/callback`. For Expo web development, also allow `http://localhost:8081/auth/callback`; add the actual hosted app origin callback if you host the Expo web app.
5. Never put the Google client secret in `.env` or app code. Keep it in Supabase's provider configuration. The mobile deep link is already registered by the app's `companion-safety` scheme.

Google sign-up routes through the existing onboarding screen so users still add their SOS phrase and trusted contact. OAuth uses the same Supabase account/profile and journey authorization policies as password sign-in. A fresh APK is required to test native browser OAuth because Expo WebBrowser is a native module; build it with the other final APK work.

## Security-hardening migration and functions

1. In Supabase Dashboard → **SQL Editor**, review and apply `supabase/migrations/202611220003_security_hardening.sql`. It removes direct client writes to journeys, access grants, safety events, evidence metadata, and notification attempts; preserves owner/contact reads through RLS; moves writes through owner-checked RPCs; adds an owner-only access-revocation RPC; validates routes/contacts; and adds atomic per-user rate limits.
2. Regenerate all seven self-contained Edge Function bundles with `node scripts/prepare-supabase-dashboard-functions.mjs`.
3. Deploy `activate-emergency`, `report-route-deviation`, `register-evidence`, `get-evidence-download-url`, `delete-evidence`, `cleanup-expired-evidence`, and `delete-account` from `tmp/supabase-dashboard-functions/`. Keep JWT verification enabled. The scheduled cleanup request still also requires the service-role bearer check in its function source.
4. Server-only configuration placeholders are in `supabase/functions/.env.example`. Configure real values only in Supabase Dashboard → **Edge Functions → Secrets**. Keep `.env` for public app URL/publishable key only; never copy the service-role or Resend credentials into app code, mobile `.env`, Cloudflare variables, or `dashboard/config.js`.
5. Use disposable accounts to verify the migration's RLS/privilege behavior, rate-limit responses, grant/revoke sharing, emergency retries, evidence upload/download/deletion, and account deletion. Do not test sensitive operations with real contacts or run cleanup against production data.

The mobile Supabase session now uses Expo SecureStore on Android/iOS, with a one-time migration from the prior local session store. Trusted contacts, route, and last-location cache also migrate into encrypted native storage; browser preview storage is not device encryption. If SecureStore fails, the app fails closed for session persistence rather than writing bearer credentials to plaintext storage.

## 1. Deploy updated Supabase functions

The generated bundles are already prepared in `tmp/supabase-dashboard-functions/`. To regenerate them after future edits, open PowerShell in the project folder and run `node scripts/prepare-supabase-dashboard-functions.mjs`.

For each function below, open Supabase Dashboard → your `Companion` project → **Edge Functions** → select the existing function → **Code**:

| Function | Complete source to paste |
|---|---|
| `activate-emergency` | `tmp/supabase-dashboard-functions/activate-emergency.ts` |
| `report-route-deviation` | `tmp/supabase-dashboard-functions/report-route-deviation.ts` |
| `register-evidence` | `tmp/supabase-dashboard-functions/register-evidence.ts` |
| `get-evidence-download-url` | `tmp/supabase-dashboard-functions/get-evidence-download-url.ts` |
| `delete-evidence` | `tmp/supabase-dashboard-functions/delete-evidence.ts` |
| `cleanup-expired-evidence` | `tmp/supabase-dashboard-functions/cleanup-expired-evidence.ts` |
| `delete-account` | `tmp/supabase-dashboard-functions/delete-account.ts` |

For each one, save a private backup of its current code, replace the editor with the entire matching file, leave **Verify JWT** enabled (the cleanup worker also retains its service-role bearer check), and click **Deploy updates**. Do not add any API keys to the function source. Existing secrets stay in Edge Function Secrets. Confirm the function shows the latest deployment time before moving to the next one. The generator prepares seven bundles with the shared validation, rate-limit, email-provider, and notification code included.

## 2. Configure Brevo email

Brevo has two separate integrations in this app: Supabase Auth confirmation/recovery mail uses Brevo SMTP; emergency and route-deviation mail uses the Brevo transactional email API from Supabase Edge Functions. Configure both if both flows are needed. Brevo requires a verified sender, and domain authentication is recommended/required by major mailbox providers for reliable delivery. If you do not own a domain, try verifying your own sender address in Brevo first; delivery to other inboxes may still be rejected or filtered. [Brevo sender setup](https://help.brevo.com/hc/en-us/articles/208836149-Create-a-new-sender-From-name-and-From-email) · [Brevo domain authentication](https://help.brevo.com/hc/en-us/articles/12163873383186-Authenticate-your-domain-with-Brevo-Brevo-code-DKIM-DMARC).

### Emergency and route emails (Edge Functions)

Create a Brevo API key in **Settings → SMTP & API → API keys** and verify a sender address. In Supabase **Project Settings → Edge Functions → Secrets**, set:

```text
COMPANION_EMAIL_PROVIDER=brevo
BREVO_API_KEY=<Brevo API key>
BREVO_FROM_EMAIL=Companion Alerts <verified-sender@your-domain.example>
COMPANION_DASHBOARD_URL=https://companion-family.pages.dev
```

Do not put the API key in the app `.env`, dashboard config, or function source. Brevo HTTP 201 with a `messageId` is recorded as **accepted**, not delivered; a bounce/delivery webhook is not currently implemented. The function retries explicit HTTP 429 responses only. Network/ambiguous outcomes are recorded as unknown without automatic retry to reduce duplicate emergency emails.

After setting the secrets, regenerate all seven Dashboard bundles with `node scripts/prepare-supabase-dashboard-functions.mjs`, then replace and deploy the seven Edge Functions from `tmp/supabase-dashboard-functions/` in Supabase Dashboard. Keep Verify JWT enabled except for the cleanup worker's existing service-role guard. Do not call the provider from a local test because that would send real email.

### Supabase Auth confirmation and password reset emails

In Brevo, open **Settings → SMTP & API → SMTP**, copy the SMTP login, and generate an SMTP key (it is separate from the API key). In Supabase **Authentication → Emails → SMTP Settings**, configure:

```text
Sender email: <verified Brevo sender address>
Sender name: Companion
Host: smtp-relay.brevo.com
Port: 587
Username: <Brevo SMTP login shown in the SMTP tab>
Password: <Brevo SMTP key, not the API key>
```

Save the settings and leave email confirmation enabled. Do not paste either secret into chat or the repository. Supabase custom SMTP and Edge Function secrets are separate settings; setting one does not configure the other. [Brevo SMTP setup](https://help.brevo.com/hc/en-us/articles/7924908994450-Send-transactional-emails-using-Brevo-SMTP) · [Supabase custom SMTP](https://supabase.com/docs/guides/auth/auth-smtp).

Emergency activation creates one event and snapshots the initial journey location. Its email includes the activation timestamp, latest backend location when available, a map link, and the authenticated dashboard journey link. Android emergency mode continues the active location task at the configured faster cadence. Per-recipient sends use a stable idempotency key; accepted recipients are not resent. Failed and ambiguous outcomes are tracked separately, with up to six total attempts per recipient across bounded function/device retries. No-recipient, failed, unknown, partial, and provider-accepted states are distinct.

Before deploying updated function bundles, apply `supabase/migrations/202611220001_notification_attempt_outcomes.sql` in Dashboard → **SQL Editor** if it has not already been applied. Then regenerate and deploy the function bundles as in Step 1. Build a fresh APK after native service source changes. These are production changes; the user asked to perform them, but production secrets and Dashboard configuration must be entered by the project owner.

## 3. Publish the family dashboard on Cloudflare Pages

The configured app URL is `https://companion-family.pages.dev`, and the local `.env` already has that dashboard URL. To make Git-based Cloudflare Pages deployments generate their ignored runtime config:

1. In Cloudflare Dashboard, open **Workers & Pages** → **companion-family** → **Settings** → **Builds & deployments** → **Build configuration**.
2. First commit and push the local `scripts/build-dashboard.mjs` and `package.json` script change to the Git repository connected to this Pages project. Then set the root directory to the repository root (leave the field blank if Cloudflare already uses the repo root), build command to `npm run dashboard:build`, and build output directory to `dashboard`.
3. Under **Environment variables**, add these two variables for both Production and Preview, using values from the project's Supabase API settings and the local `.env` (the URL and publishable/anon key only): `EXPO_PUBLIC_SUPABASE_URL` and `EXPO_PUBLIC_SUPABASE_PUBLISHABLE_KEY`.
4. Save and trigger a new deployment. The build script generates `dashboard/config.js`; that file is intentionally ignored by Git so credentials are not committed. The publishable key is designed for browser clients. Never put a service-role or Resend key in Cloudflare Pages.
5. Open `https://companion-family.pages.dev` and verify the sign-in screen appears. The dashboard uses the Pages domain as its auth email redirect; if Supabase rejects it, add `https://companion-family.pages.dev/**` under Supabase Dashboard → **Authentication** → **URL Configuration** → **Redirect URLs**.
6. In Supabase Dashboard → **Edge Functions** → **Secrets**, set `COMPANION_DASHBOARD_URL` to exactly `https://companion-family.pages.dev` (no trailing path or query string). This makes notification messages link to the hosted dashboard.

The build script can also be run locally with `npm run dashboard:build`; it reads `.env` and writes the ignored `dashboard/config.js` without printing the key.

## 4. Apply emergency-resolution SQL

In Supabase Dashboard → **SQL Editor** → **New query**, open `supabase/migrations/202611180001_emergency_resolution.sql`, paste the complete file, and click **Run**. Verify it exists with this read-only query:

```sql
select routine_schema, routine_name
from information_schema.routines
where routine_schema = 'public' and routine_name = 'resolve_emergency';
```

The expected result is one row. Do not run the SQL more than once unless it reports an error; its statements are safe to reapply, but a successful result is enough.

Also apply `supabase/migrations/202611180002_monotonic_journey_location.sql` in the same SQL Editor session. It updates the existing owner-only location RPC to ignore duplicate or older GPS timestamps and rejects fixes with accuracy over 100 meters, preventing delayed writes from moving the dashboard backward. This is a production schema change: review the SQL first and apply it only when you are ready. Verify the function was replaced by checking that the latest published location keeps the greatest timestamp during the final two-account device test.

## 5. Verify the evidence cleanup schedule

The user reports that Vault secrets are saved and job ID 1 is scheduled for 02:30 UTC. After that scheduled time, run this read-only query in SQL Editor:

```sql
select jobid, runid, status, return_message, start_time, end_time
from cron.job_run_details
where jobid = 1
order by start_time desc
limit 5;
```

Confirm the latest row has a successful status. Do not manually invoke the cleanup function: it permanently deletes expired evidence files.

## 6. Test the hosted dashboard and Supabase with disposable accounts

Use two test accounts you control and add only the Resend account-owner address as a test trusted-contact email if you want to exercise notification delivery. Do not use personal safety contacts.

1. Sign in on the app with test account A and add the test contact.
2. Start a short journey and grant account B access using B's registered email.
3. Sign in to `https://companion-family.pages.dev` as B, paste the journey ID shared by A, and confirm the map/location timestamp updates while A's journey is active.
4. With A still in the journey, test route deviation on a quiet, controlled route and inspect the recorded status. Do not test by triggering the SOS while real contacts are configured.
5. Test evidence permission, upload, signed download, expiry metadata, and delete controls using only the test journey. Provider acceptance is not proof of inbox delivery.
6. Test account deletion only on a disposable account after confirming it has no data you need.

These account-level tests require your logged-in Dashboard session and test accounts; this workspace cannot safely impersonate them or confirm production delivery.

## 7. Evaluate the audio model (requires the final APK and a consented corpus)

Do not describe YAMNet scream/shout detection as reliable until measured. An opt-in Android prediction logger is wired to Settings → Audio Model Evaluation. While an active journey has background audio monitoring enabled, it records only the per-window predicted class, confidence, timestamp, threshold, and inference latency. It does not store microphone samples or upload the CSV. The local log is capped at 20,000 rows or 4 MB. Export shares the latest 200 data rows through Android's text share sheet; clear the log before each separate evaluation session if earlier session data should not be included. Keep personal recordings private; do not upload raw evidence to the app's emergency bucket for evaluation. Only use corpus audio with appropriate consent.

After collecting predictions on the Honor X5c, fill the exported CSV's blank `actual` column with `distress` or `background` labels and preserve the remaining columns. The logged prediction is a per-window threshold result; it may differ from the multi-window automatic SOS policy. The current service uses a fixed 0.975-second duration per window. Add device memory and battery measurements separately if available. Then run the existing evaluator:

```powershell
node scripts/evaluate-audio-metrics.mjs .\path\to\consented-predictions.csv
```

It reports precision, recall, false negatives and false positives per background hour, plus latency summaries. No consented labeled corpus has been supplied or evaluated yet, so no model quality result can be reported. Background custom-phrase recognition also remains unavailable; configured phrases currently use OS speech recognition while the app is foregrounded.

## 8. Install and test on the Honor X5c — last

After the final source pass, build the APK at `android/app/build/outputs/apk/debug/app-debug.apk` for the Honor X5c's `arm64-v8a` architecture. Until that final build completes, any existing APK at that path is stale and must not be used to judge current source behavior. When we reach this step, connect the Honor by USB, enable Developer options → **USB debugging**, and accept the authorization prompt; then verify ADB sees the phone, install the newly built APK, and guide the tests together.

Do not test simulated screams/falls around other people or with real contacts configured. We’ll first verify launch, permissions, journey start/stop, live GPS, and notification status; then test check-in/resolution, evidence and background behavior with the disposable accounts.
