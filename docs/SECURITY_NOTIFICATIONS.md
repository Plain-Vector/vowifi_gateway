# Administrator access and ntfy notifications

## First run and login

The manager now requires a single administrator account. There is no default password
and no switch that silently leaves management APIs open. Before first setup the login
page and public auth status are available, while management APIs, `/ws`, `/docs`,
`/redoc` and `/openapi.json` are protected. Static frontend assets contain no credentials;
the SPA file handler refuses paths outside the built frontend directory.

At first startup a random one-time code is written to `$VOWIFI_DATA/auth/setup-code`.
Read that file on the server with the service owner's privileges. For the default
installation this is typically:

```sh
sudo cat data/auth/setup-code
```

Open the HTTPS WebUI, enter the code and choose a username and a password (12–256
characters). Only possession of the local code authorizes creating the administrator,
so merely reaching the WebUI does not let a visitor claim the installation. The setup
code is deleted after success and first setup cannot be repeated through the API.

Passwords use a random 32-byte salt and PBKDF2-HMAC-SHA256 with 600,000 iterations.
Opaque 256-bit session tokens are stored as SHA-256 digests in
`$VOWIFI_DATA/auth/admin.sqlite`, alongside account, rate-limit and engine-token hashes.
The auth directory is mode 0700; the database and setup/engine-token files are mode
0600. Passwords and session tokens are never placed in URLs or returned in status.
Session cookies are HttpOnly, SameSite=Strict, Secure over HTTPS and expire after eight
hours. Logout revokes the current session. Changing password revokes all sessions,
then creates a new session for the current browser. WebSocket broadcasts and idle
connections re-check session validity; logout/expiration disconnects existing clients.

Login/setup/password attempts are limited to ten per client IP and 100 across the
manager within a 15-minute window. Same-origin checks cover writes, login/setup and
WebSocket handshakes. Configure trusted proxy handling explicitly if terminating HTTPS
at a proxy; preserve the public Host and HTTPS scheme. Do not expose a plain-HTTP
manager. The shipped launcher serves HTTPS, including self-signed localhost testing.
HTTP is usable for loopback development tests, but its cookies are not Secure.

Authentication state is stored only under the configured data directory. This is a
single-process manager architecture, not a multi-worker or multi-administrator system.
Keep the host/Docker socket protected: application login does not sandbox someone who
already has operating-system access. Backup auth state with runtime data; it is never
part of Git. HTTPS private keys and saved manager configuration are written mode 0600.

Relevant guidance: [OWASP password storage](https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html)
and [session management](https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html).

## Recovery

Settings includes a password-change form requiring the current password. If the
password is lost, use the local recovery utility with the correct data directory:

```sh
VOWIFI_DATA=/absolute/path/to/data .venv/bin/python control/admin.py
```

Use the service's Python interpreter when deployed (for native installer installations,
usually `control/.venv/bin/python`). The utility prompts privately with getpass; do not
put the password in a command line or Git. It resets the existing administrator password,
revokes sessions and clears login throttling. It does not delete calls, SMS or rules.

## Engine callback authentication and rollout

Each instance has a separate credential in
`data/instances/<id>/run/manager-token`, mounted through the existing run directory.
The manager stores only its hash. `notify.py` sends X-Engine-Instance and X-Engine-Token.
A valid token permits only POST `/api/engine/event` for that same payload instance; it
cannot read settings, calls, SMS, SIM secrets or other management APIs. The local AGI
lookup remains network-free and does not use administrator cookies.

The callback uses the certificate already mounted into the engine at
`/etc/asterisk/certificate.crt` to pin the exact manager certificate fingerprint. This
supports the existing self-signed certificate plus host.docker.internal addressing
without accepting an arbitrary TLS peer. Tokens are never sent over plaintext HTTP or
followed across redirects. An optional custom certificate path can be set with
VOWIFI_MANAGER_CERT; the callback token file can be overridden with
VOWIFI_MANAGER_TOKEN_FILE. Missing/mismatched credentials or certificate errors fail
callback delivery and leave the local event journal; they do not stop a live call.
There is no automatic replay of the pre-existing journal.

For an existing installation, preserve custom production patches and plan a maintenance
window. **Update engine notify.py/images before enabling the new manager**: the new
notifier can still call the old manager, but the old notifier cannot authenticate to
the new manager. At manager startup tokens are created for existing instances in their
already mounted run directories; future starts create tokens before container launch.
Keep the same data directory so credentials survive. Rebuild/recreate engines during
an idle window as needed, verify callbacks, then create the administrator. SIP/IMS
credentials, Asterisk endpoint authentication and contact limits are unchanged.

If rolling back the manager, the updated engine notifier is compatible with the old
callback API. Login protection disappears with an old manager; retain external network
access controls when rolling back. Never restore an unauthenticated manager to a
publicly reachable interface merely to fix a password issue: use local recovery.

## ntfy configuration

Settings now includes ntfy alongside the existing webhook and Telegram channels:

* Enable/disable, server URL (default https://ntfy.sh), topic and optional bearer token.
* Priority 1–5 and separate incoming-call / incoming-SMS switches.
* Include or hide SMS body; optional server message caching, **off by default**.
* Save settings, then use **Send ntfy test**. This sends a synthetic notification,
  not a real SMS. A disabled ntfy channel is never contacted.

Subscribe to the same server/topic in your ntfy app. Use private access-controlled
topics for SMS; public topic names alone are not strong privacy protection. Self-hosted
servers and custom base paths are supported. Tokens require HTTPS, are redacted from
settings reads and are not included in logs. Leave the token input blank to retain it,
or explicitly remove it. TLS certificate validation stays enabled and redirects are
not followed. HTTP without credentials is supported for trusted local/self-hosted test
receivers; prefer HTTPS for actual SMS content.

Publishing uses ntfy's JSON API at the configured server base, with UTF-8 message body,
priority, tags and Cache yes/no. Message text includes the line and sender; SMS text is
included only when configured. Payload text is bounded to 4,000 UTF-8 bytes. Requests
have an eight-second timeout and run in the existing background push dispatch, not in
the Asterisk call path. Errors expose HTTP status or a fixed network/TLS message, never
tokens, full URLs or upstream response bodies. An ntfy-only configuration works without
enabling webhook or Telegram. Existing webhook/Telegram formats and switches remain.
See [ntfy publishing and authentication](https://docs.ntfy.sh/publish/).

Admin API additions:

| Route | Purpose |
| --- | --- |
| GET /api/auth/status | Public configured/authenticated state |
| POST /api/auth/setup | One-time-code setup; logs in on success |
| POST /api/auth/login | Username/password login |
| POST /api/auth/logout | Revoke current session |
| POST /api/auth/password | Change password; revoke other sessions |
| POST /api/notifications/ntfy/test | Send test using saved, enabled ntfy settings |

## Local test installation

Run `.venv/bin/python control/preview.py` after installing dependencies and building the
frontend. It binds only https://127.0.0.1:8843 by default, uses `data/local-preview`,
marks the UI as a local test installation and replaces Docker/PCSC engine operations
with disabled implementations. It adds a disabled synthetic line for inspecting settings
and matching. It does not register a SIM, dial, or send real SMS. No default administrator
is pre-created: use its own `data/local-preview/auth/setup-code`. Self-signed TLS requires
accepting the local certificate in the browser. The port/data directory can be changed
with VOWIFI_HTTP_PORT/VOWIFI_DATA. Explicit ntfy test delivery is available after you
configure it; the preview does not silently publish notifications.
