# Smart Companion Requirements Checklist

This is the implementation ledger for the requirements supplied in this project conversation. It tracks source implementation separately from device, provider, and production verification.

**Status key:** `[x]` implementation and the required verification are complete; `[~]` implementation exists but has a named gap or has not been verified; `[ ]` not implemented. I will only change an item to `[x]` after its completion criteria are met. Production changes, real alerts, and real emails are not part of local verification.

## Current pass progress — 2026-11-18

- [~] Registration now supports up to eight trigger phrases with edit/remove, enable, and independent-activation controls. Encrypted storage is retained. Account/phone end-to-end flow still awaits the final device pass.
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
- [x] `npx tsc --noEmit`, `npx expo lint`, and `git diff --check` passed after this source pass.

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

- [~] Create a unique, idempotent emergency event and save its initial location/time.
- [~] Notify configured contacts through the supported provider path (email); SMS/push are intentionally excluded unless a suitable provider is configured.
- [~] Include timestamp, latest location, and secure live journey link in notifications.
- [~] Continue emergency location updates while the location service is allowed to run.
- [~] Retry transient provider failures with bounded attempts and idempotency.
- [~] Record per-recipient attempts and provider responses; distinguish accepted from delivered.
- [x] Keep provider credentials server-side and do not return fake delivery success.
- [~] Verify authenticated emergency/route calls and notification outcomes using disposable accounts and a test-only recipient.

## E. Evidence capture and access

- [~] Request consent and permissions for emergency audio evidence.
- [~] Capture and timestamp short audio evidence when permitted.
- [~] Capture and timestamp short video evidence when the app is foregrounded, the camera is available, and permission is granted.
- [~] Associate evidence with the emergency event and upload when connectivity permits.
- [~] Store evidence privately and enforce owner/authorized-viewer access with expiring signed links.
- [~] Verify evidence permission, upload, download authorization, deletion, expiry, and scheduled object cleanup.

## F. Family dashboard and account controls

- [~] Authenticate dashboard users and require an explicit journey ID/share grant.
- [~] Show authorized live map, journey state, last update time, emergency events, and evidence.
- [~] Subscribe to Supabase realtime updates and handle reconnect/stale states.
- [~] Verify the hosted dashboard configuration and two-account access policies.
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

## K. Release and final verification

- [~] Run typecheck and lint after implementation changes.
- [~] Run unit/integration checks that do not send real communications or mutate production data.
- [ ] Build the final physical-device Android APK only after source work is complete.
- [ ] Install and complete the authorized final feature/lifecycle check on the Honor X5c.
- [ ] Update `docs/IMPLEMENTATION_STATUS.md` and this checklist from the observed final results.
