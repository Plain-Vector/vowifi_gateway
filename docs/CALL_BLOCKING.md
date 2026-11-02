# Incoming call filtering

## Existing architecture and integration point

Reviewed fork baseline: `e371984` (Plain-Vector/vowifi_gateway main). The repository
contains the FastAPI manager (`control/app`), React client (`webui`), per-SIM engine
(`engine`), installer and Asterisk templates. There was no existing test suite,
blocklist subsystem or application-level WebUI authentication.

Incoming IMS INVITEs arrive over the existing ePDG/SWu tunnel at the P-CSCF-matched
`volte_ims` PJSIP endpoint. Its `context=volte_ims` handles the registered GRUU using
the broad `_.` extension. Previously the sequence was CALLPEER, Progress, log and
call_in callback, WaitForPrecondition, Ringing, then simultaneous Dial of external
SIP accounts and the optional WebRTC account. Without endpoints it answers and waits.
The `h` handler reports disposition to the manager, which updates SQLite and broadcasts
to WebSocket clients. Incoming SMS uses `volte_ims_msg`. Local outgoing calls use
`from-local` and Dial to `volte_ims`; SMS uses `msg-from-local`.

The new local AGI runs immediately after saving CALLPEER, before Progress and client
ringing. It reads a private-to-the-engine *filter-only* SQLite snapshot and sets the
fixed variable CB_REJECT=1 only for an Enforce match. Reject uses the project's
existing PJSIPHangup(Decline) application (SIP 603), with Hangup(21) fallback. Rejected
calls skip the ordinary inbound hangup callback, avoiding modification of another
open call. The original caller ID is retained in the filter event and ordinary call
history; no inbound push notification is emitted for a rejected call.

No IMS authentication, SIP contact limits, registration, outgoing route, SMS route,
SWu tunnel code or precondition patch is changed. `WaitForPrecondition` remains in
its existing allowed-call sequence. Production-specific patches have not been
obtained or tested; this feature must be merged with those changes, not copied over
the production checkout wholesale.

`render.py` renders the templates at startup and after P-CSCF discovery. The engine
reconnect watcher can re-render/reload PJSIP. Rule changes do not invoke these paths:
the manager atomically replaces `data/instances/<id>/run/blocking.sqlite`, already
visible through the engine's existing `/run/vowifi` directory mount. There is no
Asterisk reload or engine restart for a rule or mode change. The initial installation
of the new image/dialplan does require a planned engine restart.

## Matching and modes

New installations default to **Monitor**; category and unknown-ID blocking start off.

1. Parse a bounded caller ID, including tel:/sip: URI user parts; normalize French
   domestic, +33 and 0033 forms. Other countries and overseas territories use E.164.
2. For a visible valid ID: personal whitelist, personal blacklist, enabled ARCEP
   ranges, enabled Saracroche, otherwise allow. Both global and line-specific
   personal lists participate; any personal whitelist entry wins.
3. Restricted IDs (including numeric Asterisk presentation 32..63) use the withheld
   setting. Missing, invalid and unavailable IDs use a separate setting. Hidden digits
   are not treated as a visible, whitelisted caller. Raw ID remains in the audit event.

Rules are exact numbers or explicitly selected prefixes, never user-provided regex.
Normalization checks syntax/length, not whether a number has been allocated. Domestic
notation assumes metropolitan France; use +590/+594/+596/+262 for overseas territories.
Caller ID remains spoofable; filtering does not authenticate the caller.

* Disabled: no rule match or ordinary filter audit event; routing continues.
* Monitor: all decisions are recorded, action is allow.
* Enforce: all decisions are recorded; matches are rejected before endpoint delivery.

Decision fields: mode, normalized, would_block, action, source, rule, reason.
AGI uses indexed local prefix candidates (at most 15), SQLite read-only immutable
connections, a 50 ms SQLite busy timeout, a 100 ms query progress deadline, a 500 ms
lookup/protocol-input alarm and at most 200 ms to acknowledge a rejection command.
Interpreter startup/process scheduling are outside the Python alarm. Missing/corrupt
snapshots, query errors and deadline expiry default to allow. This is a POSIX/Linux
implementation. An AGI crash before a decision leaves the dialplan's CB_REJECT=0.
The same matcher source is shipped into the engine and loaded by the control plane.

After lookup, a detached notify.py process sends a base64 JSON report to the existing
manager engine-event endpoint. It performs no HTTP in the decision process, invokes
no shell and journals using the existing `/logs/events.jsonl` mechanism. If callback
delivery fails, events remain in local logs; automatic replay of this pre-existing
journal is not implemented. Thus a manager outage can leave events absent from WebUI
history; existing valid local snapshots still enforce rules while the manager is down.
Lookup errors are reported locally and through the callback when available. Numbers
are never sent to a blocklist provider. Existing user-configured incoming-call push
notifications retain their existing behavior for allowed calls.

## Persistence

All authoritative state uses the existing `vowifi.sqlite`; migrations are additive
and idempotent (blocking_migrations v1). Existing messages and calls are not altered.

| Table | Purpose |
| --- | --- |
| blocking_rules | Personal allow/block rules; scope, canonical number, exact/prefix, description, enabled |
| blocking_config | JSON settings per scope; `*` is global, other keys are instance IDs |
| blocking_providers | Schedule, last success, next attempt, version, entry count, sanitized error, failure count |
| blocking_imports | Provider rules, separate from personal rules |
| blocking_events | Raw caller ID, line, timestamp, Asterisk call ID, structured decision; deduped per line/call ID |

Global Disabled is a master stop: it masks every line mode, including Enforce overrides.
Those overrides resume when global filtering is re-enabled.
Line settings otherwise inherit global fields individually. A PUT replaces the line's overrides;
null/omitted fields inherit. An empty object restores inheritance. Global omissions
use defaults. Personal line rules extend global rules. Imported datasets and update
schedules are global. Snapshots contain only effective settings and enabled applicable
rules, no SIP/IMS/SIM credentials or provider tokens. They are written to a sibling
temporary file, closed and fsynced, then replaced with os.replace. Calls with an already
open snapshot continue reading that consistent generation. Updates do not interrupt
active bridged calls. Snapshots are readable by Asterisk; protect the enclosing data
directory since rules contain personal numbers.

## API and authorization

All management endpoints are under `/api/blocking`:

| Method / path | Behavior |
| --- | --- |
| GET /settings?scope=* | Global, overrides and effective settings |
| PUT /settings?scope=* | Replace scope settings (mode, arcep, saracroche, block_withheld, block_unavailable) |
| GET /rules?scope=*&kind=block&search=…&enabled=true | List/search/filter personal rules |
| POST /rules | Create rule |
| PUT /rules/{id} | Edit rule |
| DELETE /rules/{id} | Remove rule |
| POST /lookup | Local test: instance, number, presentation; does not add history |
| GET /events?instance=…&limit=100&offset=0 | Filter-event history, bounded page size |
| GET /providers | Status and update metadata |
| PUT /providers/saracroche | auto_update and interval_hours (1..720, default 24) |
| POST /providers/saracroche/update | Manual attempt; honest unavailable/error response |

FastAPI rejects unknown fields, invalid scopes, modes and malformed rules. Duplicate
rules return 409. Existing `/api/engine/event` accepts bounded validated call_filter
reports, deduplicates them, and stores enforced rejections as closed `blocked` calls.

The upstream application has **no built-in login/access-control mechanism** to reuse.
Existing reverse-proxy/VPN access control must protect the whole gateway, including
engine callbacks. The new management routes additionally support
`VOWIFI_BLOCKING_TOKEN`: when set, every request requires X-Blocking-Token. Set it in
the manager process environment (systemd drop-in or container configuration); the
existing installer does not forward this variable automatically. Enter it in the
Call Blocking page's Access token panel; the browser stores it in sessionStorage.
Do not put it in URLs or Git. This token does not add authentication to legacy APIs.
Cross-origin/cross-site browser writes are rejected; configure proxies to preserve
the public Host. Do not treat this CSRF guard as user authentication.

## WebUI

Call Blocking remains available without a connected SIM reader. It provides global
and per-line modes/category controls, reset-to-global inheritance, source/update
status, schedule, manual attempt, searchable blacklist and whitelist editors,
individual enable/disable, descriptions, exact/prefix selection, local test lookup,
and paginated event history. Existing theme tokens support light/dark mode and
responsive layout. The softphone's Recent calls adds Block this number for its line.

## Saracroche investigation (2026-11-02)

Sources:

* [Official downloadable-database help](https://saracroche.org/fr/help/database-downloadable/)
* [Current Android source](https://codeberg.org/cbouvat/saracroche-android), reviewed commit
  `1c1d524a15fc71a1ab67a99828aa5ad2fdc1abfc`.
* [Archived GitHub source](https://github.com/cbouvat/saracroche-android): current default
  branch is a relocation notice, not the active Android implementation.

Inspected Android files under `app/src/main/java/com/cbouvat/android/saracroche`:
`config/Config.kt`, `network/NetworkService.kt`, `network/ApiModels.kt`,
`service/ListService.kt`, `service/ListSyncService.kt`, and Room database definitions.
No Android code or downloaded database is redistributed in this feature.

The source declares API_HOST `https://app.saracroche.org` and API_BASE_URL `/api/v2`.
The app discovers metadata with **GET /api/v2/lists**. Downloads use the exact
`download_url` returned in that catalog: absolute URL or path relative to API_HOST.
There is no fixed database-download URL to assume. Catalog Accept is application/json;
pattern downloads request application/x-ndjson. Each nonblank line contains name and
pattern. No explicit archive/decompression layer is present in NetworkService; any
HTTP content encoding is a transport concern, not a documented portable archive format.

Metadata contains id, name, description, license, is_enabled_by_default, priority,
channel, type, download_url, version, hash, item_count. The app skips a list when its
stored hash and item count agree, and skips download when hash is null. In the inspected
path the hash is an update discriminator: downloaded bytes are **not** cryptographically
verified against it. Malformed NDJSON lines are skipped. Successful content replacement
uses a Room transaction (delete old list items, insert new items, update count/hash).
Metadata synchronization is separate. Removed API lists are deleted. The last update
time is advanced only after all list updates succeed; interval is 24 hours.

Catalog requests send X-Country-Code without organization credentials, or X-Device-Id
and X-API-Key when both are available. Downloads send the latter pair when available.
POST /api/v2/activate exchanges an activation token for an API key. These are facts
from app source, **not a supported public gateway contract or permission to use them**.
No endpoint was probed and no list was downloaded during this investigation.

The Android code has GPLv3 licensing; database licenses are separate metadata fields.
Neither the application license nor the website-content license establishes permission
to redistribute databases or automate third-party downloads. Official help still says
a documented download API will be available in the future and invites contact.
Consequently the Saracroche adapter deliberately returns `access_required`, has zero
entries initially and makes **no network request**. Its controls do not imply a working
Saracroche data feed. Needed before enabling an actual adapter: provider confirmation
of gateway use, database license/redistribution terms, documented endpoints, supported
authentication, formats, integrity checks, rate limits and empty-list semantics.

The provider interface, scheduler and atomic validated replacement pipeline exist;
there is no user-configurable arbitrary URL or private-endpoint bypass. Future permitted
adapters return a bounded Dataset with canonical exact/prefix rules and must validate
transport integrity and impose download limits. Unsupported pattern syntax must be
rejected rather than interpreted as regex.

## ARCEP

The optional category represents **verified automated calling**, not a finding of
fraud or a guarantee that every call is commercial. Legitimate services can use it.
Sources: [ARCEP numbering dossier](https://www.arcep.fr/la-regulation/grands-dossiers-thematiques-transverses/la-numerotation.html)
and [decision 2025-2215, consolidated rules §2.3.7](https://www.legifrance.gouv.fr/loda/id/JORFTEXT000054122929).
Verified on 2026-11-02: metropolitan roots 0162, 0163, 0270, 0271, 0377, 0378, 0424,
0425, 0568, 0569, 0948, 0949; overseas roots 05987/09475 (+590), 05988/09476 (+594),
05989/09477 (+596), 02688/02689/09478/09479 (+262). The 22 E.164 prefixes are versioned
in the matcher; changes require reviewing official rules and shipping a code update.
Separate public-interest numbering is not included. ARCEP is a local bundled category,
not a remote blocklist downloaded by the scheduler.

## Updates

A managed lifespan task checks due providers every 30 seconds; background work runs in
a thread, outside call processing. Manual and scheduled attempts share a nonblocking
single-update lock. Default interval is 24 hours, configurable 1..720 hours. Failure
backoff is 5, 10, 20, 40… minutes, capped at 24 hours. Disabling auto-update clears the
next attempt; manual attempts remain possible. Metadata survives manager restarts.

A dataset is completely validated before a transactional replacement of provider rows
and successful-update metadata. Invalid numbers, unknown match types, empty/oversized
datasets and transport failures retain previous valid content and version. Snapshot
publication follows commit; if publication fails, existing engine snapshots remain
valid, the error is recorded, and a later successful retry/startup republishes. A
publication failure may temporarily leave engines on different valid generations.
Sanitized errors never include upstream exception text, credentials or private data.

## Installation, validation and rollback

Do not run an installer blindly against a production checkout with uncommitted IMS
patches. First preserve those changes in a private branch/backup and merge this feature
into that checkout with review. Back up config/data and existing engine/control image
references. Schedule an idle maintenance window for the initial engine restart.

Build using the existing contexts:

```sh
docker build -t vowifi/engine:call-blocking engine
docker build -f control/Dockerfile -t vowifi/control:call-blocking .
```

For native control, rebuild WebUI and install control requirements as usual. Keep
`engine/blocking_match.py` alongside the repository: the native manager loads that
canonical module; the control Dockerfile copies it into the matching /app layout.
Select the new engine image through VOWIFI_ENGINE_IMAGE in the manager environment.
Restart the manager to run additive migrations and publish snapshots, then recreate
test line engines in an idle window. Use the existing installer's mode-aware lifecycle
only after deciding how to preserve local patches and image names. Nothing here deploys
automatically. Rule updates thereafter require no restart.

Begin with Monitor, use the local test tool, inspect history, then test real incoming
calls to SIP/WebRTC, outgoing calls, SMS, withheld IDs and failure-open behavior on a
non-production line before choosing Enforce. Actual IMS preconditions and SIP response
behavior require the project's patched Asterisk image and carrier hardware.

Developer checks:

```sh
python -m venv .venv
.venv/bin/pip install -r requirements-dev.txt
.venv/bin/python -m pytest -q
npm ci --prefix webui
npm run build --prefix webui
python -m compileall -q control/app engine
bash -n install.sh engine/entrypoint.sh
```

Linux build dependencies for pyscard: libpcsclite-dev and swig. GitHub Actions runs
backend tests and frontend builds without secrets, deployment or image publication.
Tests cover normalization, exact/prefix/enabled rules, allowlist precedence, withheld
and missing IDs, modes, per-line inheritance, local AGI protocol, fail-open snapshot
errors, atomic snapshot replacement, validated dataset failure preservation, backoff,
source unavailability, scheduler cancellation, API validation/token/CSRF checks,
callback deduplication, existing call persistence, and rendered SIP/WebRTC/SMS/outbound
routing. Rendering and AGI process tests do not replace a live Asterisk/IMS call test.

Rollback immediately to Disabled globally (the master stop),
or disable the affected lines individually. For code rollback, restore the previous
engine/control image and reviewed source in a maintenance window. Additive blocking_*
tables may remain: old code ignores them. Restore the SQLite backup only if needed;
doing so also discards later ordinary calls/SMS. Keep production patches intact.
