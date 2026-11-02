# Installing this branch for a production-line test

Source: https://github.com/Plain-Vector/vowifi_gateway/tree/codex/call-blocking

This is a testing branch. Real carrier/SIM calls and the installation's private IMS
patches have not been validated in this development environment. CI checks Python,
React and rendered routing; it is not a real IMS call test. Nothing deploys automatically.

## Obtain the exact branch

For inspection on another machine, without changing an existing installation:

```sh
git clone --branch codex/call-blocking --single-branch https://github.com/Plain-Vector/vowifi_gateway.git vowifi-gateway-test
cd vowifi-gateway-test
git log -1 --oneline
```

Do not immediately run install from a second checkout on the same production host:
the installer uses fixed service/container/image names and can replace the existing
installation even when a different port is selected.

## Existing production installation

1. Record the existing checkout commit, deployment mode, data directory, port and image
   references. Keep a private backup of config.yaml, the SQLite database, certificates
   and instance run state. Use SQLite's backup API or stop the manager before copying
   its database; protect backups because they contain credentials and SMS.
2. Preserve *all* local IMS/precondition/source changes outside the published branch.
   Review `git status` and both staged/unstaged diffs. Do not run reset/clean or replace
   the checkout with this fork. Do not push private patches or runtime data to GitHub.
3. Fetch the fork's codex/call-blocking branch, merge it with the preserved local source
   in a private checkout/branch, and resolve differences in the dialplan and Asterisk
   patches explicitly. Keep the installation's original data directory and mode.
4. In an idle maintenance window, stop the VoWiFi lines through the existing WebUI.
   Save/tag the old engine image and, for docker mode, the old control image for rollback.
5. From the reviewed, merged installation checkout, rebuild **both** the engine and
   control/WebUI. The existing installer supports:

   ```sh
   sudo ./install.sh reload --engines
   ```

   Preserve any existing `.env`/VOWIFI_DATA_DIR/mode/port settings. This command rebuilds
   the engine, updates/restarts the manager, then removes old engine containers; lines
   must be started again in the WebUI. A reload without --engines can reuse the old
   engine image and is insufficient for this feature. Do not add --no-cache unless a
   clean rebuild is actually needed.
6. Open the normal HTTPS WebUI. Read the one-time setup code locally from
   `<actual-data-directory>/auth/setup-code`, choose an administrator username/password,
   and start one test line. Do not use the development preview's setup code or data.

The new manager rejects anonymous engine callbacks. Updating the notifier/engine before
the secured manager is ideal for a staged rollout; the stopped-line rebuild above avoids
leaving old engines running against the new manager. Tokens are created under each
instance's existing mounted run directory. Certificate pinning uses the certificate
shared by the manager and engine. See SECURITY_NOTIFICATIONS.md for recovery and scope.

## Test before enabling rejection

Start with **Monitor**, with Saracroche initially off. Confirm normal IMS registration,
incoming ringing on SIP and WebRTC, outgoing calls and SMS in both directions. Confirm
that call/SMS history and engine state events still arrive after login protection.

Then enable Saracroche, check successful download/version/entry counts, and use the local
lookup tool with known test numbers. The source is the Android-compatible public
catalog, not a guaranteed stable documented API. Current FR data is CC BY-NC-SA 4.0;
commercial use needs separate terms. Personal whitelist has first priority; the ARCEP
category is independent and optional. Coverage statistics count theoretical number
space, including possibly unallocated numbers.

Test a personal blacklist entry in Monitor, inspect its event, then choose **Enforce**
for the test line and place a controlled incoming call. Confirm rejection before client
ringing. Test whitelist override and your chosen withheld/unavailable-ID policy. Keep
other lines in Monitor while testing. Global Disabled overrides all line modes.

For ntfy, enter server/topic and optional token under Settings, save, and send a synthetic
test. Then test one real incoming SMS. Use a private access-controlled topic; text is
forwarded only if enabled. No ntfy credentials or real external delivery were tested
by the developer; automated/browser delivery tests used a local receiver.

## Rollback

Global **Disabled** immediately stops filtering without restarting an engine. For code
rollback, stop the test lines, restore the backed-up source/images and restart in a
maintenance window. Preserve private patches and runtime data. Additive blocking/auth
tables can remain; an older manager ignores them, but its lack of login must be covered
by external network access control. Use `control/admin.py` for password recovery rather
than rolling back to an unauthenticated manager just to regain access.
