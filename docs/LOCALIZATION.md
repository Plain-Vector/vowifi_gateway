# WebUI localization (English, French, Russian)

The language selector appears on the administrator screen and in the application
header, including mobile layouts. It changes mounted UI text immediately. Language
selection never saves server settings, switches SIMs, reconnects SIP/WebSocket sessions,
resets forms or reloads the application.

## Preference and fallback

The explicit browser preference is stored under `localStorage['vowifi-language']`.
A supported explicit preference wins over browser settings. Otherwise, the first
supported `navigator.languages` entry (or `navigator.language`) is normalized to
`en`, `fr` or `ru`; unsupported preferences fall back to English. Blocked storage still
allows in-memory switching. Browser detection does not write an explicit preference.
Each browser/profile has its own preference; it is not part of the gateway database.

All catalogs are bundled locally; there is no translation service, remote catalog
request or caller/SIM data transmission. English remains the complete fallback.
`html[lang]` and the current document title follow the selected language.

## Architecture and dependencies

- `src/i18n/index.js`: one i18next instance, detection, stable translation function,
  structured notifications/errors, known status-code presentation and Intl formatting.
- `src/i18n/LanguageSelector.jsx`: accessible selector with language endonyms.
- `src/i18n/locales/{en,fr,ru}.json`: semantic keys grouped by feature, 807 keys in each
  catalog, including cardinal plural variants. English is not used as a lookup key.
- `src/i18n/validation.js`: localized native constraint messages. It preserves values
  and constraints, clears messages on input/reset/programmatic value updates and never
  submits forms or moves focus. Structured API validation is translated by machine
  type; unknown diagnostics are preserved.
- `scripts/check-i18n.mjs`: recursive key parity, nonempty values, interpolation and
  fixed React markup and registered source-key checks. `npm test` runs it before the frontend suite, including CI.

Runtime dependencies added: `i18next` 26.7.1 and `react-i18next` 17.1.11, pinned by the
npm lockfile. No backend, database, installer or Engine dependencies change. Use
`npm ci`, not a separate manual dependency installation, for reproducible builds.

Each component subscribes with `useTranslation`. The stable translator is deliberately
absent from network/telephony effect dependencies. Components, forms, media elements
and providers are never keyed by language. Notifications retain keys/interpolation
values so existing toasts and frontend errors can change language while visible.

Plain interpolation is rendered as React text. Rich messages use fixed React elements;
interpolation is escaped before markup parsing and decoded only as text nodes. User,
SIM, caller-ID and backend values cannot create elements or replace official links.
Date/time and numeric display use Intl with the selected language and the viewer's
local timezone. API values, phone numbers, protocol data and numeric inputs stay raw.
Russian cardinal forms cover one/few/many/other; no English suffixes are concatenated.

## Complete coverage inventory

| Feature | Files | Covered UI |
| --- | --- | --- |
| Shell/navigation | App.jsx, LanguageSelector.jsx | Page titles, navigation and mobile accessible names, themes, preview banner, SIM counts, WebSocket notifications |
| Authentication | AuthGate.jsx | Setup/login/logout, setup-code instructions, credentials, busy states and known failures |
| Dashboard | Dashboard.jsx | Reader/card status, registration pipeline, start/unlock/PIN warnings, retries, line actions and known reason codes |
| Line selector | SimSelector.jsx | Full/mobile labels, readers, line states, selection and single-line hint |
| Phone | Softphone.jsx | Registration/call state, incoming/active call controls, mute/record/DTMF descriptions, history and delete confirmations |
| Messages | Messages.jsx | Conversations, compose, sending/delivery states, dates, counts, delete confirmations and failure wrappers |
| Physical SIM | SimConfig.jsx | Form labels/help, PIN workflows, validation, account conflicts, PANI explanations and settings feedback |
| Provisioning | ProvisionModal.jsx | Required PIN/IMEI, SMSC, port allocation, addressing and start warnings |
| Connection/help dialogs | SipInfoModal.jsx, PushInfoModal.jsx | SIP client instructions, clipboard feedback, webhook/Telegram setup and field descriptions |
| eSIM | Esim.jsx | Profiles, activation/download/rename, exclusive-access stop warning, download stages, diagnostics and notifications |
| Filtering | CallBlocking.jsx, blockingPresentation.js, useBlockingSettings.js | Global/line inheritance, drafts/save/error states, modes, ARCEP/caller-ID risks, provider configuration/status/license, personal lists, simulation and history |
| Settings/ntfy | Settings.jsx | Control/TLS/network settings, recovery/debug descriptions, notification privacy/options/events/tests and password changes |
| Logs | Logs.jsx | Sources/tabs, empty states, errors/retry/refresh controls; payload unchanged |
| Validation/errors | i18n/index.js, i18n/validation.js | Native form messages, documented auth/rule errors and structured API validation |

Mode semantics remain explicit: **Disabled** disables filtering; **Monitor** logs
matches and allows calls; **Enforce** rejects matching calls. Translated labels never
become API values (`disabled`, `monitor`, `enforce`, etc.). Saracroche remains opt-in;
matching, downloading and rejection are separate. Source/author links and the
CC BY-NC-SA 4.0 noncommercial/attribution/share-alike notice are retained in all locales.

## Intentionally untranslated

- Product names and protocol identifiers: VoWiFi Gateway, IMS, SIP, RTP, Asterisk,
  PC/SC, SIM, eSIM, Saracroche, ARCEP, ntfy, TLS, ePDG, EID, APN, ICCID, IMEI, etc.
- Phone numbers, addresses, ports, API paths, configuration keys, usernames, credentials,
  activation codes and generated protocol/client configuration.
- Custom line/reader/profile/list names, caller data and personal rule descriptions.
- Raw log payloads, protocol/notification example payloads, unknown vendor/server
  diagnostics and provider-supplied license/name metadata. UI wrappers are localized;
  unknown error text is never translated by fuzzy matching.
- Official author/organization names, source URLs, license identifiers and language
  endonyms (`Русский`, `Français`, `English`).

## Validation and limits

- 41 frontend tests pass, including existing blocking regression tests, detection and
  persistence, fallback, catalog failures, dates/numbers/Russian plurals, native/server
  validation, hostile interpolation, login/PIN/representative views in all languages,
  raw logs and live toast translation.
- A mocked incoming/active phone session survives RU/FR/EN switches with one Phone
  instance, one start, no stop, the same audio element, unchanged SIM and no extra
  provisioning/history reads. These are lifecycle tests, not actual carrier calls.
- Blocking drafts and scope survive language switches; no API writes occur until
  explicit Save, which sends stable configuration identifiers and the selected scope.
- Real HTTPS Chromium: all eight views in each language at 1280 px and 390 px, no
  page errors or horizontal overflow, bounded mobile navigation height, unchanged
  scoped draft, no language-triggered writes, preference survives reload/new session.
  These checks use isolated data and synthetic reader/line/read-only API fixtures;
  no hardware actions, calls, external messages or production data are involved.
- Backend: existing 97 tests pass; compileall and diff checks pass. npm ci and the
  production build pass. Six pre-existing npm audit findings remain. Bundling all
  locales increases the JS bundle; the pre-existing Vite >500 kB warning remains.

Actual incoming/outgoing calls, SMS and carrier rejection still require the owner's
hardware acceptance test. No telephony code or production deployment is changed here.

## Upgrade after PR review and merge

Keep the existing installation, data directory, administrator account and `.env`.
Inspect local modifications first, especially private IMS/precondition changes and any
old polling workaround. Back up/reconcile them explicitly; do not reset or clean a
production checkout. With a reviewed clean/fast-forwardable source checkout:

```sh
cd /srv/docker/vowifi/source-new
git status --short
sudo git pull --ff-only origin main
sudo ./install.sh reload
```

If local changes/divergence prevent the pull, stop and merge those changes privately.
No reinstall, `source-new/data` clearing, `--engines`, `--no-cache`, uninstall or purge
is required. In the existing local mode, reload rebuilds WebUI, installs its locked
npm dependencies and briefly restarts native Control. Running Engine containers are
not recreated; the Engine image is reused if present. Verify that image exists before
reload because the existing installer can build a missing image.

After reload, sign in normally, switch all three languages, navigate pages, test saving
settings and verify calls/SMS as before. Rollback restores the previous source and uses
the same Control-only reload; no database downgrade is needed. This localization PR
follows the owner’s review/merge instructions. Production deployment remains a separate manual operation.
