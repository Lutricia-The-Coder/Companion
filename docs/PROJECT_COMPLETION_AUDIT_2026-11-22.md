# Project completion audit — 2026-11-22

This audit compares the current Companion project with the completion criteria supplied by the owner. “Implemented” means local source exists; it does not imply a fresh APK, production verification, reliable model performance, or guaranteed Android background execution.

## Requirement status

| Requirement | Status | Evidence / remaining work |
| --- | --- | --- |
| Working React Native application | Fresh arm64 build installed and launched; feature verification incomplete | Expo SDK 58 / React Native app with Expo Router. APK `android/app/build/outputs/apk/release/app-release.apk` was installed on the Samsung Galaxy A24 (`SM-A245F`) and its process was observed running. |
| Onboarding and authentication | Implemented; end-to-end verification incomplete | Supabase email/password, confirmation callback, Google OAuth flow, profile, phrase, contacts, permission and sharing setup exist. Google provider credentials/redirects and the latest build still require verification. |
| User-configurable phrases connected to detection | Implemented with a platform limitation | User phrases feed exact transcript matching using offline-capable OS speech recognition in foreground. Arbitrary phrase recognition is not supported by the background YAMNet classifier. Do not claim background personalized phrase detection. |
| Audio processing and distress classifier | Implemented; model quality unverified | Android service captures/processes/window audio and runs on-device YAMNet scoring. A labeled consented corpus and handset precision/recall, false-positive rate, latency, memory, and battery results are absent. |
| Agentic safety decision engine | Implemented; physical lifecycle validation pending | Deterministic state machine combines phrase, audio, motion/fall, route, and journey context; deduplicates activation and records bounded decision traces. Existing automated unit coverage passes. |
| Real Android location | Implemented; latest-build validation pending | GPS foreground/background location, owner-authorized publishing, freshness/accuracy filters, retry, realtime dashboard updates, and faster emergency cadence exist. OS/vendor lifecycle limits remain. |
| Route deviation | Implemented; physical false-alarm validation pending | Point-to-route distance, configured thresholds, GPS accuracy allowance, consecutive off-route fixes, and backend alerts exist. Route/provider realism and actual handset behavior remain to test. |
| Backend integration | Implemented in source; authenticated production behavior partly unverified | Supabase Auth, RPCs, RLS, Realtime, Edge Functions, private Storage and deployment sources exist. Owner reports applying the latest security migration and deploying the seven updated functions; source parity and disposable-account integration behavior have not been independently verified in this turn. |
| Configurable SMS, email, and push | Partly implemented; push awaits production setup | Email via Resend has preferences, bounded retries, idempotency, and provider outcome records. SMS is intentionally not implemented because it requires a paid provider. SDK 58 `expo-notifications` is installed; authenticated owner-controlled token registration/removal, preference UI, journey-authorized contact targeting, Expo ticket outcomes and bounded retry source are implemented. Apply migration `202611220004_expo_push_devices.sql`, deploy updated `activate-emergency` and `report-route-deviation`, and configure Android FCM v1 in EAS before push works in production. Expo ticket acceptance is not handset delivery. |
| Emergency evidence capture | Implemented; platform/remote checks pending | Consent-gated short audio/video capture, timestamps, emergency association, private upload, expiring links, access controls and retention/cleanup code exist. Background camera/microphone access is OS-limited; latest upload/permissions/cleanup behavior needs verification. |
| Family dashboard | Implemented; two-account verification pending | Authenticated responsive dashboard with explicit journey ID, authorized Supabase reads, realtime, live map, status/history and evidence access exists. Verify shared-user scope and revocation with disposable accounts. |
| Security rules and authorization | Implemented in local source; owner reports remote deployment | SecureStore session/config storage on native, server-side ownership checks, RLS/ACL hardening, private evidence, limits, input validation, secret templates and privacy-conscious logging exist. Remote ACL/RLS behavior and migration/function parity still require disposable-account verification. |
| Automated tests | Local suites pass except where stated below | Safety engine (25), backend callable/provider policy (8), audio evaluation tooling (4), email provider (7), and Expo push adapter (4) passed: 48 tests total. Typecheck and Expo lint passed. Native Android JVM test suite was not rerun in this turn. Tests do not verify live providers, Supabase production, classifier accuracy, or device lifecycle. |
| Build/setup instructions | Present | See `docs/MANUAL_FINALIZATION.md`, `docs/IMPLEMENTATION_STATUS.md`, and the Android build script. A fresh APK and install are still required after recent source changes. |
| Honest constraints and configuration | Present; this audit adds the notification gap | Provider secrets remain server-side. OAuth, email sender/domain, Android permissions, hardware, model evaluation, and deployment requirements are disclosed in docs and templates. |

## Automated checks run in this audit

- `npm test`: passed, 25 tests.
- `npm run test:functions`: passed, 8 tests.
- `npm run test:audio-evaluation`: passed, 4 tests.
- `npm run test:supabase-email`: passed after updating its assertions for accepted/unknown outcomes and Node's strip-only TypeScript support, 7 tests.
- `npx tsc --noEmit`, `npx expo lint`, and `git diff --check`: passed.
- Supabase CLI, production alerts/emails, device build/install, and destructive account/evidence operations were not run.

## Work required before all supplied criteria are met

1. Implement trusted-contact SMS delivery behind a server-side provider adapter and add per-channel preferences and delivery-attempt records. Configure a provider such as Twilio only when credentials and a permitted sender are available.
2. Apply the push-device migration, deploy the two regenerated emergency/route function bundles, and configure Android FCM v1 credentials in EAS. For iOS push, also configure Apple push credentials. Validate Expo ticket outcomes and receipt/handset delivery separately. SMS is excluded pending a no-cost provider.
3. Rebuild and install the current Android source on the Samsung; verify sign-in/onboarding, phrase detection limitations, audio behavior, location, route deviations, provider outcomes, evidence access, dashboard sharing, and lifecycle/permission/network cases.
4. Evaluate YAMNet against a consented, labeled representative corpus and report precision, recall, false positives/hour, false negatives, latency, memory, battery use, and environmental limits.
5. Verify the user's reported Supabase deployment using disposable owner/contact accounts and confirm rate limits, RLS, sharing revocation, evidence expiry/deletion and scheduled cleanup. Do not use real emergency contacts for tests.

The project is **not yet complete against the supplied criteria** while SMS/push and the validation steps above remain outstanding.
