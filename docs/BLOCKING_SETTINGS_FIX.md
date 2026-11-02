# Call Blocking settings persistence fix

## Root causes

- The old `load()` read settings, rules, events and provider configuration together on
  mount, every 15 seconds, and whenever rule search, pagination or scope changed. It
  replaced editable state, including unsaved country/interval fields. An older read
  could overwrite an optimistic checkbox change while its PUT was still pending.
- Each settings checkbox sent a complete scope configuration immediately. The payload
  was based on the last server `global`/`override`, while the optimistic change updated
  only `effective`. Overlapping callbacks/reads could therefore send or display stale
  values. A PUT intentionally replaces overrides; omitted override keys mean inherit.
- Operational loads had a generation guard, but direct PUT responses did not. Scope
  changes could occur during a save; late responses could populate the current view
  with another scope's settings. Fetching rules also needlessly reloaded settings.
- Provider controls mixed immediate writes with separate country/schedule buttons and
  implicit downloads. There was no consistent draft or success/error indication.
- The provider API filled omitted schedule fields with model defaults (`true`, `24`)
  even for a connection-only request. This could silently reset an existing schedule.
  Options and schedule were also committed in separate transactions.
- The API client treated FastAPI's validation-error array as an object with a `message`
  property, hiding field-specific 422 explanations behind the generic HTTP status.

The SQLite scope persistence and inheritance calculation themselves were correct.
Global Disabled is an intentional master stop, not a lost line override. The UI now
shows the configured line mode and explains when Global Disabled masks it at runtime.

## Behavior after the fix

Filtering settings and shared provider settings have separate explicit Save/Discard
controls and Loading, Unsaved changes, Saving, Saved and Error states. Saves read back
and compare authoritative server values; failures retain drafts and show real errors.
Changing a line with unsaved scope edits requires confirmation. Individual fields can
inherit again; resetting all overrides requires confirmation and then an explicit save.
Provider edits remain shared and retained while switching SIMs.

The operational poll and manual refresh update history, personal rules, provider
statistics and update status, without editing either settings form. Separate generation
counters ignore obsolete scope/operational/save responses. Form fields are disabled
during saves. Enforce requires confirmation, and rule-source activation never silently
turns on rejection or triggers a download. Saracroche connection/schedule/list selection
is saved before a separate download; automatic updates and matching remain distinct.
Provider options/schedule are written atomically and omitted fields retain their values.
The API and stored schema remain compatible; no reset or migration is required.

## Compact page and decision history

The page has five linked sections: Filtering, Saracroche, Personal lists, Number test
and Call history. The overview shows **saved effective** mode/matching status separately
from unsaved edits. Detailed risk explanations and shared database configuration are
collapsible. Database status, coverage, errors and update action remain visible; update
errors survive operational polling and an update completing after a scope switch uses
the latest scope for refresh.

Blacklist/whitelist use keyboard-accessible tabs. Rule validation is shown at the number
field. Lookup results distinguish Allowed, Would be blocked in Enforce and Blocked by
current settings; lookup never places a call and cannot prove carrier rejection.

History filters are applied on the server before pagination (SIM, decision, source,
start/end timestamps). The existing events response remains compatible; `has_more` is
an additive pagination field. Rejected rows represent engine-reported reject decisions,
whereas Monitor matches explicitly show that calls were allowed. Mobile history uses
stacked rows and database configuration remains collapsed by default. Light/dark theme
tokens and existing settings-save guards are preserved. These compact UI additions require no additional dependencies.

## Validation

- Backend: 97 tests, including authenticated GET/PUT, Global and two-SIM isolation,
  inheritance/reset, all modes, validation/auth failures, provider partial PUTs and a
  fresh Python interpreter reading the same SQLite file. Credentials/session survive
  initialization. Monitor always allows matching calls.
- Existing incoming/outgoing call callback and rendered-dialplan regression tests pass.
  A rendered dialplan is not a carrier/SIM call test.
- Frontend: 21 automated tests, including rapid edits, explicit saves, 15-second poll
  callbacks while dirty/saving, out-of-order settings/operational responses, scope-change
  cancellation, per-field inheritance/reset/discard, save failures, Enforce confirmation,
  provider source/countries/schedule/list drafts, browser-close warning and API errors.
- Real HTTPS Chromium smoke with isolated data: the actual 15-second poll preserves
  dirty settings; saved settings survive a page reload; line changes do not change
  Global. Desktop and 390 px mobile render without page errors or horizontal overflow.
- Locked npm installation, production build, Python compileall and diff checks pass.
  Existing six frontend dependency audit findings and the Vite bundle-size warning
  remain. No additional dependency audit findings were introduced by the test tools.
- Additional tests cover personal rule add/edit/delete, inline validation, database
  update busy/error states, all lookup verdicts and history filters before pagination.
  Real Chromium checks include keyboard tabs, local import, light/dark desktop and
  390 px mobile layouts, filter accessible names and server history filtering.
- No production access or real carrier/SIM calls were performed.

## Deploy to an existing native/local installation after merge

**Engine rebuilding is unnecessary.** This fix does not change Engine files, Asterisk,
IMS, SIP/RTP routing, SIM handling, engine container configuration or installer scripts.
Do not use `--engines`, `--no-cache`, fresh install, or a database reset.

1. Record the current commit and make a private backup of the configured data directory
   (use SQLite's backup API for a live database), `.env` and local source patches.
2. Fetch the fix branch in the existing checkout and review the diff. Preserve and merge
   any uncommitted IMS/precondition changes privately; do not use reset/clean or blindly
   switch a dirty production checkout. In particular, review a production-only removal
   of the old UI timer: the new operational-only timer supersedes that workaround.
3. Once private local edits are reviewed and reconciled, fetch and fast-forward the
   existing installation to main. Do not force a dirty/divergent checkout to match it:

   ```sh
   cd /srv/docker/vowifi/source-new
   git status --short
   sudo git fetch origin
   sudo git pull --ff-only origin main
   ```

   If status shows local edits or the pull cannot fast-forward, resolve the private
   source changes explicitly before proceeding; do not use reset/clean.
4. From the original installation directory, keeping its data path, `.env`, port and
   stored local deployment mode, run:

   ```sh
   sudo ./install.sh reload
   ```

   In local mode this rebuilds WebUI, updates Control dependencies and restarts the
   native Control service. Existing Engine images are reused and running Engine
   containers are not recreated. If the expected Engine image has been deleted, the
   existing installer may rebuild a missing image; verify it is present beforehand.
   Control/WebSocket management access briefly reconnects during the service restart.
5. Reload the browser (hard refresh if needed), sign in with the existing credentials,
   save an innocuous Monitor setting, reload and verify Global plus each SIM override.
   Verify normal IMS/calls/SMS on a test line before using Enforce. Existing administrator
   credentials, runtime data and rules remain in place.

Rollback: restore the privately backed-up source and run the same Control-only reload.
No database downgrade is needed. Unsaved browser edits are never persisted as runtime
configuration and are lost if the user confirms navigation/closure.
