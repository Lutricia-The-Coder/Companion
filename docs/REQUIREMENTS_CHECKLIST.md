# Smart Companion Requirements Checklist

This is the implementation ledger for the requirements supplied in this project conversation. It tracks source implementation separately from device, provider, and production verification.

**Status key:** `[x]` implementation and the required verification are complete; `[~]` implementation exists but has a named gap or has not been verified; `[ ]` not implemented. I will only change an item to `[x]` after its completion criteria are met. Production changes, real alerts, and real emails are not part of local verification.

## Current pass progress — 2026-11-23

- [~] Fixed the route-less Supabase journey creation path: omit `p_route` when empty so the deployed RPC default applies, and reduce oversized routes to its 1,000-point limit. Journey startup now stops with the returned backend error instead of showing a local-only session as protected. Included in the APK installed on the Samsung on 2026-11-23; cloud journey start still needs retesting.
- [~] Bound the safety agent and emergency request to the newly created/persisted journey ID, avoiding stale React state when an immediate personal phrase triggers SOS. Included in the 2026-11-23 APK; end-to-end device pass remains.
- [~] Added an Edge Function guard so concurrent duplicate SOS requests cannot send while the first request is pending; retries are allowed only after a persisted retryable provider outcome. Local bundle is generated at `tmp/supabase-dashboard-functions/activate-emergency.ts`; manually deploy it in Supabase Dashboard before testing this protection.
- [x] Replaced the unconditional “Your contacts have been alerted” home headline with “Emergency protocol is active” plus an explicit provider outcome that distinguishes accepted, partial, pending, failed, no-recipient, and unknown states.
- [x] Built and installed `android/app/build/outputs/apk/release/app-release.apk` (arm64-v8a, 2026-11-23) on the authorized Samsung A24. The app process launched; feature testing remains pending.
- [~] B/C source audit: Android uses `AudioRecord` at 16 kHz mono, overlapping 0.975 s YAMNet windows every 0.48 s, on-device YAMNet score policy, native fall heuristics, timestamps, bounded error recovery, and a transcript-free opt-in prediction log. The JS deterministic engine covers independent exact phrases, confidence windows, route/fall/audio signal combinations, check-ins, de-duplication, and decision history. JVM and JS unit tests cover policy, not acoustic accuracy or physical service behavior.
- [~] The updated APK is installed and launched. Retest that a signed-in, route-less journey creates successfully; then verify monitor status, background/foreground transitions, phrase activation while app is open, scream/shout response, check-in timing/cancel/escalation, duplicate suppression (after deploying the Edge Function bundle), location-linked emergency, and recovery after app interruption.
- [ ] YAMNet thresholds and fall heuristics are not safety-validated. A consented labeled audio corpus and handset measurements are still required; custom phrases are only recognized through foreground OS speech recognition, not by the background YAMNet classifier.

- [~] Added an opt-in Android YAMNet prediction metadata log and CSV share/delete controls; no microphone samples are stored. Evaluation labels, consented corpus metrics, and Honor X5c latency/memory/battery measurements remain outstanding.

- [~] Registration now supports up to eight trigger phrases with edit/remove, enable, and independent-activation controls. Encrypted storage is retained. Account/phone end-to-end flow still awaits the final device pass.
- [~] Email/password and Google OAuth flows are implemented on mobile sign-in/sign-up and dashboard sign-in; Google OAuth credentials, redirect allow-list, and provider flow remain to be configured/verified in Supabase and Google Cloud.
- [~] Phrase recognition now chooses an installed offline English locale, waits for final transcripts, handles Android's omitted confidence as unknown rather than false zero, and applies low-score policy only to real scores. Honor X5c phrase recall still awaits the fresh APK and real speech.
- [~] Onboarding choices now control phrase, background audio, motion/fall, evidence consent, email preferences, and opt-in journey sharing. Authentication confirmation and live settings sync require end-to-end validation.
- [~] Added native motion-monitor enable/disable and service status reporting. Kotlin compilation and handset behavior await the final APK build.
- [~] Route deviation distance thresholds are configurable and applied in foreground and background checks. Route false alarms/cadence await handset validation.
- [~] Foreground and background publishers now reject stale (>30 s), poor-accuracy (>100 m), or out-of-order location fixes; the last accepted position stays timestamped and ages to stale. Physical GPS behavior still awaits handset validation.
- [~] Location upload failures now retain only the newest accepted fix and retry it on the next GPS callback, with a visible pending-sync state; reconnect behavior still needs the Honor network-loss check.
- [~] Added a migration that makes the Supabase location RPC reject >100 m accuracy and ignore duplicate/out-of-order timestamps. It remains a local migration until you apply it in Dashboard → SQL Editor.
- [~] Background GPS now changes from 5-second/5-meter journey cadence to 2-second/1-meter emergency cadence, then returns to normal after resolution; timing and battery behavior still need the Honor check.
- [~] Safety check-ins have a visible countdown and synchronized app/native safe-confirmation. The current installed binary does not contain the new native bridge yet.
- [~] When a saved journey is restored after the user reopens the app, Companion now restarts Android background location only if foreground and background permissions remain granted; reboot recovery still requires the user to reopen the app and be tested on the Honor.
- [~] Added a web-only speech-monitor stub so browser startup does not import the native recognition module; browser export and the native device build remain unverified.
- [x] `npx tsc --noEmit`, `npx expo lint`, `npm test` (25 tests), 2 duplicate-retry policy tests, 7 Resend tests, 4 Expo Push tests, Android `:expo-companion-monitor:testDebugUnitTest`, and `git diff --check` passed for this source pass. These do not replace the physical-device checks above.

## A. Registration, identity, and personalized phrases

- [~] Register with name, email, password, and Supabase authentication.
- [~] Configure trusted emergency contacts during onboarding and manage them later.
- [~] Add, edit, enable/disable, and delete personal trigger phrases.
- [~] Configure per-phrase independent emergency activation.
- [~] Choose supported monitoring features during onboarding and have those choices control runtime behavior.
- [~] Configure emergency email preferences; confirm all onboarding preferences survive email confirmation and sign-in.
- [~] Request and review location, microphone, notification, and camera permissions at appropriate points in the journey.
- [~] Configure journey tracking and explicit trusted-contact sharing preferences, including opt-in sharing at each journey start.
- [x] Store mobile trigger phrases in device-encrypted storage; do not store or display recognized transcripts.
- [~] Connect saved phrases to final on-device speech transcripts; verify the no-confidence and low-confidence paths on the Honor X5c.
- [~] Use the best feasible offline recognizer and document arbitrary phrase, streaming, latency, memory, and license constraints.

## B. Passive distress detection and agent

- [~] Capture Android microphone audio through the native service while background audio monitoring is explicitly enabled.
- [~] Preprocess and window incoming audio for on-device inference.
- [~] Classify scream/shout sounds on-device with YAMNet; evaluate against a consented labeled corpus.
- [~] Use the best feasible architecture for personalized phrases: foreground on-device OS transcript recognition, with background sound classification separated and limitations disclosed; no reliable arbitrary-phrase background keyword model is validated.
- [~] Score audio and motion signals and timestamp detected events.
- [~] Feed phrase, sound, fall, and route signals into the safety decision engine.
- [~] Log errors and recover processing when the model or audio pipeline fails.
- [~] Keep check-ins visible, cancellable, and synchronized with the native service deadline.
- [~] Validate false positives, false negatives, recall, precision, latency, memory, and battery impact on representative data and the handset.

## C. Live journeys, location, and route safety

- [~] Start and end journeys with authenticated ownership.
- [~] Publish live location to Supabase and update authorized family dashboard viewers in realtime.
- [~] Show location timestamp and avoid presenting stale or poor-accuracy fixes as current.
- [~] Queue/retry location publication after connectivity loss and reconnect.
- [~] Adjust location cadence during emergencies within Android and battery constraints.
- [~] Share a journey with explicitly authorized trusted contacts; enforce authorization in the backend.
- [~] Display a map-based live journey to authorized dashboard users.
- [~] Plan a road route and detect sustained deviations with a user-configurable threshold plus GPS-accuracy allowance.
- [~] Notify configured contacts of route deviations and prevent GPS-noise-only alerts.
- [~] Verify location cadence, stale display, sharing, realtime updates, route alerts, and connectivity recovery on the Honor X5c and with disposable accounts.

## D. Emergency communication

- [~] Create one unique emergency event per activation and save its initial journey location/time; source implementation is complete, deployed verification remains.
- [~] Notify configured contacts through the supported email provider path (SMS/push are intentionally excluded); verify with the configured provider and a disposable contact.
- [~] Include activation timestamp, latest available backend location, map link, and authenticated live journey dashboard link in emergency emails; deployed output remains unverified.
- [~] Continue emergency location updates while the location service is allowed to run.
- [~] Retry transient provider failures with a stable provider idempotency key and a six-attempt per-recipient cap; do not resend recipients already accepted by the provider. Verify after deploying the schema and functions.
- [~] Record per-recipient attempts, provider references/responses, and accepted/failed/unknown outcomes. The app does not claim inbox delivery; remote persistence is unverified.
- [~] Keep delivery behind a provider adapter; Resend is implemented and server-side secret setup is documented. Existing secret values are not inspected by source checks.
- [~] Keep provider credentials server-side and do not return fake delivery success; remote function configuration still needs validation.
- [ ] Apply `202611220001_notification_attempt_outcomes.sql`, deploy updated function bundles, build/install the updated APK, then verify emergency/route calls and notification outcomes using disposable accounts and a test-only recipient.

## E. Evidence capture and access

- [~] Request consent and permissions for emergency audio evidence.
- [~] Capture and timestamp short audio evidence when permitted; Android may suspend or deny background microphone recording.
- [~] Capture and timestamp short video evidence when the app is foregrounded, the device is unlocked, the camera is available, and permission is granted.
- [~] Associate evidence with the emergency event and upload when connectivity permits.
- [~] Store evidence privately; enforce owner/authorized-viewer reads and metadata expiry through migration `202611220002_evidence_retention_and_access.sql` and updated signed-link functions.
- [~] Let users choose 7/30/90-day retention; apply locally immediately and sync account/cloud retention after the migration is deployed.
- [~] Keep timestamped history, authorized signed downloads, deletion, offline upload retry, and a bounded scheduled cleanup worker.
- [~] Apply migration, deploy generated `register-evidence`, `get-evidence-download-url`, and `cleanup-expired-evidence` bundles, and verify expiry/deletion/cleanup against a disposable account. Remote production state is unverified.

## F. Family dashboard and account controls

- [~] Authenticate dashboard users and require an explicit journey ID; database RLS only returns journeys shared with the signed-in account or owned by it.
- [~] Show the authorized live map and route, journey/emergency status, location timestamp/accuracy/stale indicator, route deviation and emergency history, notification attempts, and evidence access.
- [~] Subscribe to Supabase realtime updates and present loading, empty, offline, query-error, and reconnect states.
- [~] Keep evidence behind an authenticated short-lived download-url function; verify two-account journey and evidence policies in the hosted dashboard.
- [~] Publish the changed dashboard bundle and validate auth, share revocation, realtime updates, and evidence access with two disposable accounts.
- [~] Verify account deletion and its cleanup behavior with a disposable account.

## G. Android monitoring and platform behavior

- [~] Run appropriate foreground services and visible notifications for background location/audio work.
- [~] Handle runtime permissions and explain battery-optimization limits.
- [~] Handle network reconnection, monitor errors, and service/process interruption where Android permits.
- [~] Keep Kotlin-to-React-Native communication typed and avoid leaking secrets or transcripts.
- [~] Validate process kill/restart, reboot, permission revocation, battery saver, low battery, network loss, and notification behavior on the Honor X5c.
- [x] Do not promise operation after force-stop, device shutdown, permission revocation, or battery depletion.

## H. Optional wearable readiness

- [~] Keep smartwatch integration optional and document a future adapter for supported fall/impact signals.
- [x] Do not make first-release safety monitoring dependent on a wearable.

## I. Supabase, deployment, and dashboard

- [~] Keep the existing Supabase project, migrations, RLS policies, and Edge Functions as the active backend.
- [~] Confirm the configured app/dashboard project URL and publishable key without exposing secret keys.
- [~] Confirm deployed function source matches local emergency, route, evidence, account, and cleanup sources.
- [~] Configure server-only email provider secrets and document sender restrictions; never claim contact delivery when the provider cannot accept the recipient.
- [~] Configure the private evidence bucket, Storage policies, signed-link behavior, and scheduled object cleanup.
- [~] Keep the family dashboard hosted with auth, explicit journey grants, maps, and realtime subscriptions.
- [~] Validate remote authenticated flows and provider results using disposable accounts without modifying production data.

## J. Cross-platform previews

- [~] Keep a web-compatible preview that does not import unavailable native-only modules at startup.
- [~] Keep iOS permission and speech-recognition paths where supported; test only in an iOS native build, not by claiming Expo Go/browser equivalence.
- [~] Clearly disclose that the web preview cannot provide background audio, motion, or native location services.

## K. Security and privacy

- [~] Use Supabase Auth with encrypted native session persistence; migrate older local sessions into SecureStore and keep browser sessions on browser storage.
- [~] Keep trigger phrases, trusted contacts, route cache, last/pending location, and other sensitive native configuration in encrypted device storage; browser preview remains browser-local storage.
- [~] Enforce row-level owner/shared-contact reads and remove direct client write privileges for journey state, access grants, safety events, evidence metadata, and delivery attempts.
- [~] Restrict journey share grants/revocation, event creation/resolution, location publication, evidence operations, and account deletion to authenticated server-side checks.
- [~] Rate-limit sensitive RPCs and Edge Function operations; cap trusted contacts, payload sizes, route sizes, evidence size/type, and provider retries/recipient counts.
- [~] Keep evidence in private Storage with expiry-aware authorized reads and short-lived signed downloads.
- [~] Keep provider/service credentials server-side, make generated runtime config ignored, and document `.env.example` plus server-only `supabase/functions/.env.example` templates.
- [~] Avoid logging raw provider/database errors that may contain user data; preserve bounded delivery outcomes without provider response bodies.
- [~] User reports applying `202611220003_security_hardening.sql` and deploying the updated function bundles; no secrets are tracked. Verify effective ACL/RLS/rate-limit/share-revocation behavior with disposable accounts before marking complete.

## M. Notification channel completion gap

- [x] Email provider adapter, bounded retry and idempotency policy, outcome logging, and email preferences are implemented in local source.
- [ ] SMS delivery is not implemented. Trusted contact phone numbers are stored but do not receive alerts.
- [ ] Remote push delivery and recipient device-token registration are not implemented. Android foreground service notifications are local OS notifications, not push alerts to trusted contacts.
- [ ] Select/configure providers and implement SMS/push delivery and preferences before claiming the completion requirement “configurable SMS, email, and push notifications” is met. Provider credentials must stay in Supabase Edge Function Secrets; real provider delivery needs a disposable recipient and handset validation.

## L. Release and final verification

- [~] Run typecheck and lint after implementation changes.
- [~] Run unit/integration checks that do not send real communications or mutate production data.
- [ ] Build the final physical-device Android APK only after source work is complete.
- [ ] Install and complete the authorized final feature/lifecycle check on the Honor X5c.
- [ ] Update `docs/IMPLEMENTATION_STATUS.md` and this checklist from the observed final results.
