# VoWiFi Gateway fork

- Development target: https://github.com/Plain-Vector/vowifi_gateway (`origin`).
  Original project: https://github.com/pagecat/vowifi_gateway (`upstream`, fetch only).
- Communicate with the owner in Russian. Keep source identifiers and project-facing
  documentation consistent with the existing English codebase.
- Use dedicated `codex/*` feature branches. Commit locally after validation; publish
  only when requested. Never deploy to production automatically.
- Production may have uncommitted IMS precondition patches. Preserve and review them;
  do not replace a production checkout or assume these patches exist locally.
- Preserve IMS registration, outgoing/incoming routing, SMS, SIP/WebRTC, multi-instance
  behavior, SIP authentication and contact limits unless explicitly in task scope.
- Call-filter decisions must be local, bounded and fail open. Do not send incoming
  caller numbers to providers. Saracroche is opt-in and uses its verified public
  Android catalog protocol (FR data: CC BY-NC-SA 4.0, noncommercial). Preserve
  attribution, per-list license checks and access denials; do not bypass restrictions.
- Run `python -m pytest -q`, `npm ci --prefix webui`, `npm run build --prefix webui`,
  `python -m compileall -q control/app engine`, and `git diff --check` as applicable.
  Development dependencies: `pip install -r requirements-dev.txt` (Linux pyscard needs
  libpcsclite-dev and swig). A rendered dialplan test is not a real IMS call test.
- See docs/CALL_BLOCKING.md for architecture, source constraints and rollback;
  docs/GITHUB_WORKFLOW.md for fork/PR workflow. Keep these current with behavior.
- Management APIs and WebSockets require administrator sessions. Engine callbacks use
  separate per-instance credentials; preserve their scope and certificate pinning.
  See docs/SECURITY_NOTIFICATIONS.md for first setup, recovery and safe rollout.
- Never commit runtime data, SIM/IMS/SIP credentials, tokens, logs or local private patches.
