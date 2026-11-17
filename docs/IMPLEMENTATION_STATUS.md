# Implementation status

Last reviewed: 2026-11-17

This is an in-progress safety prototype, not a validated emergency service. Emergency detection and provider delivery have not been validated sufficiently to rely on them as a sole safety measure.

## Current app and safety features

- Expo SDK 58, React Native 0.88, TypeScript, Expo Router, generated Android native directories.
- Sign-in/registration, journey history, trusted contacts, live journey location with accuracy/timestamp, shared-contact dashboard, route deviation event handling, SOS event handling, private evidence upload/download, and account deletion are wired to Supabase.
- Supabase email signup now requests an app deep link and includes a callback route to exchange the confirmation code for a session. The app scheme is `companion-safety`; its Auth redirect allowlist is configured for the callback and local web development URLs. The callback syncs the initial trusted contact from device storage after confirmation.
- Android foreground monitor supports YAMNet scream/shout inference and accelerometer fall heuristics while its foreground service runs. Personalized trigger phrases use on-device OS speech recognition while the app is foregrounded; the background service does not transcribe custom phrases. The PDF's requested investigation of offline streaming recognition/keyword spotting is documented as an outstanding engine evaluation, not claimed as done. Web preview does not run safety monitoring.
- YAMNet is a pretrained general-audio classifier, not validated for this app. Scream detection recall, false positives per hour, runtime latency, and environmental limits are unknown. Fall thresholds are heuristics.
- Route checks use fetched or manually supplied route coordinates; emergency mode attempts higher cadence location updates. GPS and network/background behavior still need device testing. Notifications are email-only through Resend; SMS and remote push are not in the active alert path. The user reports that the Resend API key and `onboarding@resend.dev` sender are configured as Supabase function secrets, and that Supabase Auth custom SMTP has sent a confirmation email. Resend's test sender is restricted to the account owner address, so it cannot yet deliver to arbitrary trusted contacts without a verified domain.
- Evidence objects use a private bucket and short-lived signed access. With recording consent, audio/video evidence is attempted after an emergency; the local `register-evidence` source sends trusted contacts a 15-minute signed download link and records delivery outcomes. Updated local shared-code functions must still be deployed; the Supabase CLI is blocked by Windows Application Control, so use the generated self-contained files under `tmp/supabase-dashboard-functions/` in the Dashboard editor. The JWT-protected cleanup function is deployed. The user reports that Cron/Net/Vault are enabled, the two cleanup secrets are saved in Vault, and daily schedule job ID 1 exists; its first run and result are not yet verified.
- Per-user email preferences and notification-attempt history are implemented locally with owner/participant RLS. The user reports applying both `202611170001_email_notification_preferences.sql` and `202611170002_location_evidence_controls.sql`; a follow-up query showed the new notification table, profile preference column, and location publishing function. Dashboard SQL execution may not update Supabase's migration-history table, so schema presence and migration-history bookkeeping are distinct. The `delete-account` function now appears in the Dashboard and is reported deployed; remote source parity and authenticated behavior remain unverified.
- An arm64 Android debug APK was built on 2026-11-17 at `android/app/build/outputs/apk/debug/app-debug.apk` (version 1.0.0; previously inspected as `arm64-v8a`). It predates the current native emergency-delivery retry change, so it is not the APK to use for final testing. The user requested installation and device validation at the end. The earlier UI launch on the Honor X5c predates the Supabase migration and current native project; live handset behavior still needs retesting.

## Supabase migration status

The application source now uses Supabase Auth, Postgres, Realtime, private Storage, and Edge Functions instead of Firebase client APIs. Migration files are in `supabase/migrations/`; functions are in `supabase/functions/`. Firebase no longer appears in the active app source.

The user-created Supabase project `Companion` uses project reference `xiqteymwbnqmtsueubhu`. Migration `202611160001_companion_safety.sql` was applied remotely. The user reports applying the two `20261117...` migrations; a query of application schema objects confirmed the notification-attempt table, profile preference column, and location RPC. The original six app Edge Functions are deployed with JWT verification enabled, and the user reports `delete-account` now appears after Dashboard deployment. The project `.env` and generated ignored dashboard config have previously been checked for the public project URL and publishable key. Do not copy or print secret values.

The base schema and six original functions are deployed. Read-only production checks confirmed that anonymous requests see zero rows in app tables and protected functions reject unauthenticated requests with HTTP 401. These checks do not exercise authenticated journeys, realtime, evidence uploads, or provider delivery. Auth settings and redirect URLs were previously checked; the user later confirmed email confirmation works. `scripts/configure-dashboard.ps1` generates local dashboard config and `scripts/start-dashboard.ps1` serves `http://localhost:8000` on this computer only. The user reports Resend function secrets, Auth SMTP, the newer SQL, account deletion function, and cleanup schedule are configured. Authenticated feature/provider behavior has not been validated. A Firebase CLI login is unrelated to Supabase access.

Free-tier usage is subject to quotas and Supabase can pause free projects after inactivity. This is suitable for a prototype, not guaranteed emergency-service uptime. Resend lists a free tier with a 3,000-email monthly quota and a 100-email daily limit; it still requires a verified sender domain to mail trusted contacts. Do not place a service-role, Resend, or other secret key in app or dashboard configuration.

## Remaining setup and validation

1. Deploy the updated local `activate-emergency`, `report-route-deviation`, and `register-evidence` sources using generated bundles; then compare deployed source/behavior. The CLI is blocked by Windows Application Control; use Dashboard → Edge Functions and keep JWT verification enabled.
2. Configure a verified sending domain (or test only to the Resend account owner's address with `onboarding@resend.dev`) before trying trusted-contact delivery. Keep SMS/push out of scope unless a no-cost provider is found and configured.
3. Configure and host the dashboard on a public HTTPS origin if family members need to access it remotely. The current `localhost:8000` dashboard is only reachable on this computer; set the public dashboard URL in Edge Function secrets and Supabase Auth redirects after hosting.
4. With disposable authenticated accounts, test journey sharing, live Realtime location, route deviation, email outcomes, evidence permissions/expiry, and account deletion only after backing up test data. Do not use production contacts for alert tests.
5. At the user's requested final device-testing stage, build/install the current arm64 APK on the Honor X5c and validate process kill/restart, reboot, permission revocation, battery saver, low battery, network loss, location cadence, and foreground service notifications. Current native emergency delivery retries are local code and have not been device-tested.
6. Evaluate audio classification on a consented labeled corpus and report precision, recall, false positives/hour, false negatives, memory/runtime latency, battery impact, and limitations. Do not claim configured custom phrases work in native background monitoring; they currently use OS speech recognition in foreground.
7. Cleanup schedule job ID 1 is reported created for 02:30 UTC. Check `cron.job_run_details` after its first scheduled run to verify success. Do not run cleanup against production data during this audit because it deletes expired objects.
8. Route planning uses public routing data and coordinate geometry; evaluate provider availability, route realism, and deviation false alarms during device testing. Wearable integration remains optional and is not implemented.

## Validation run for the source migration

- `npx tsc --noEmit` — passed.
- `npx expo lint` — passed.
- `npm test` — 20 safety decision, route, location, and provider-policy tests passed.
- `npm run test:functions` — 8 emergency authorization/state and provider outcome tests passed.
- `:expo-companion-monitor:testDebugUnitTest` — passed (YAMNet score and fall-policy unit tests).
- `npx expo export --platform android --no-bytecode --no-minify --max-workers 2` — passed after email-only changes; Metro bundled 1,338 modules.
- Supabase production read-only checks — anonymous table requests returned zero rows; six protected functions returned HTTP 401.
- `scripts/build-android.ps1 -BuildTarget physical` — passed; final APK manifest confirmed the callback scheme and `arm64-v8a` ABI.
- Follow-up `scripts/build-android.ps1 -BuildTarget physical` — passed after removing remote push and SMS delivery; `android/app/build/outputs/apk/debug/app-debug.apk` verified arm64-v8a, 104,116,554 bytes. Not installed.
- `npm run test:supabase-email` — 6 email target, preference, retry, Resend request, idempotency and rejection tests passed. `npm run test:functions` — 8 existing provider/state unit tests passed.
- Dashboard static host — `http://localhost:8000/` and generated `config.js` return HTTP 200. The host uses Node.js because Python is unavailable.
- Current implementation pass — `npx tsc --noEmit`, `npx expo lint`, `npm test` (21), `npm run test:supabase-email` (7), and `npm run test:functions` (8) passed. The Dashboard function bundle generator ran and validated exactly one external import in each generated bundle.
- Audio evaluation tool — `npm run test:audio-evaluation` (2 tests) passed. It reports accuracy and optional device resource metrics from labeled CSV data; actual classifier evaluation still requires a consented corpus and handset measurements.
- Android monitor JVM tests remain unverified. The first wrapper attempt tried to download Gradle and failed because network access was denied. A retry using the repository's short-path Gradle cache stayed silent for more than a minute and was stopped. Re-run `scripts\\gradle-short-home.ps1` with `:expo-companion-monitor:testDebugUnitTest` when the local Gradle cache is responsive.
- `dashboard/app.js` and the bundle builder passed JavaScript syntax checks. No production alerts or emails were sent.
- `scripts/evaluate-audio-metrics.mjs` and tests were added to report precision/recall, false positives per background hour, false negatives, and optional latency/memory/battery summaries from labeled on-device results. No corpus has been supplied or run, so classifier quality remains unverified.
- `npx expo-doctor` could not be rerun during the follow-up because npm registry access returned `EACCES`. A previous run after dependency alignment passed 20/20 checks.

These do not validate authenticated Supabase flows, deliver email, evaluate classifier accuracy, or exercise Android service lifecycle on a physical phone. The current APK is built but was intentionally not installed or launched; handset testing remains scheduled for the end.

## Requirement review from the user-provided 33-page PDF

| Requirement | Local implementation | Test / limitation |
|---|---|---|
| Expo/React Native app, registration, auth, account profile, trusted contacts | Implemented using Expo Router and Supabase, following the repository's Expo CNG instruction rather than the PDF's incompatible CLI/React Navigation request | Authenticated phone flow still needs final testing |
| Personalized phrase create/edit/delete, independent trigger, real phrase matcher | Implemented; encrypted on-device phrase storage and speech transcript matching | OS recognizer/language availability; foreground only; no offline arbitrary phrase model validation |
| Separate scream/shout audio ML and motion/fall monitoring | Native Android YAMNet inference plus Kotlin/JS fall heuristics | Model label scores and heuristics unvalidated on a representative dataset/device |
| Deterministic agentic state machine and auto alert | Implemented; phrase independent setting, multimodal context, check-in escalation, duplicate suppression | Android background native lifecycle on Honor not retested after Supabase migration |
| Continuous real GPS, route planning/deviation, live dashboard | Implemented with Expo location task, route geometry, Supabase Realtime, authorized dashboard, stale/accuracy display; emergency requests faster cadence | Device/vendor, connectivity, route accuracy and battery behavior unverified; no guaranteed OS operation after force stop/reboot/permission revoke |
| Email notifications with provider outcomes | Supabase Edge Function email-only adapter, retry and preference logic; SMS and remote push removed from alert delivery | User reports Resend secrets and custom SMTP configured; signup confirmation received. Test sender limits trusted-contact delivery; updated function sources still need deployment and alert delivery test |
| Evidence capture and secure access/retention | Opt-in foreground audio/video attempt after alert; private Storage, short-lived signed links, deletion and cleanup function | Background camera cannot be guaranteed; local evidence-link changes need deployment; cleanup schedule is reported created but first run is unverified |
| Family dashboard, authorized journey, map, events, evidence, notification history | Supabase auth/RLS/Realtime dashboard; attempt history display added; sign-out control present | Authenticated two-account journey, realtime, and evidence flows not tested; dashboard is local-only until hosted |
| Privacy/settings, permission review, account/data deletion | Preference UI, system app settings link, and delete-account endpoint | User reports delete-account deployed; remote source parity and authenticated deletion validation remain outstanding |
| Tests, build, setup instructions, wearables architecture | Existing core logic tests and Android detector JVM tests; setup docs; no wearable dependency | No wearable integration; deployed Supabase integration/Android device tests/audio corpus metrics remain outstanding |

The PDF's requests to use Firestore/FCM and React Native CLI/React Navigation were superseded for this repository by the explicit Supabase direction and the project `AGENTS.md` rules requiring Expo Router/CNG. This review does not claim production readiness.
