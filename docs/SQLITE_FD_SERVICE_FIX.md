# SQLite FD exhaustion and service-number correction

## Confirmed defects

Production reported 602 descriptors for auth/admin.sqlite and 390 for vowifi.sqlite,
against a 1024 descriptor limit, with both databases passing quick_check. The Control
connection factories used SQLite transaction contexts without explicitly closing their
connections. SQLite context exit commits/rolls back but does not close; cyclic garbage
collection timing allowed descriptors to accumulate under authentication/polling and
scheduler traffic. Raising the process limit would only delay the failure.

Both factories now close in finally, including setup and commit failures. Snapshot
publication and temporary in-memory lookup connections also close explicitly. All Control
SQLite users (including auth middleware, admin, SMS/calls, provider configuration and
scheduler) were audited. No schema, database path, user, session or data replacement is
introduced. Scheduler and provider failures now report exception types, safe SQLite
error codes/messages and traceback locations, including underlying causes. Arbitrary
exception text, URLs and credentials are excluded from diagnostics.

Personal rule validation rejected short codes although the existing matcher already
accepted them. Exact 2–6 digit codes starting with 1–9 now keep their original digits;
prefix rules still require normal telephone prefixes. This applies to both personal
lists and global/per-SIM rules. Existing E.164 normalization and whitelist precedence
remain intact. Existing UI help/error translations are updated; no localization feature
is introduced here.

## Outgoing behavior: investigated, cause not established

The single call_filter AGI invocation is in the incoming volte_ims context. External SIP
and WebRTC endpoints use from-local; AMI Originate also selects from-local and preserves
the destination, including 666/1023. That outgoing context has no filtering invocation.
The pre-existing post-Dial PJSIPHangup(Decline) can report an unsuccessful carrier call
as a decline; this does not establish that filtering rejected the call.

No SIP/IMS/Engine routing changes are made. Real failed calls cannot be diagnosed from
the supplied FD counts alone. Obtain the failed call's time, SIM, destination, Asterisk
DIALSTATUS and redacted SIP response/Q.850 cause before changing outbound handling.
Rendered dialplan and mocked AMI tests are not real IMS calls. Engine's snapshot lookup
runs in a short-lived incoming AGI process; process exit releases that descriptor and
it cannot explain long-lived Control auth/main database accumulation.

## Validation

Backend regression coverage includes retained connection references, rollback, failed
commit and permission setup, and a Linux subprocess with garbage collection disabled
and FD soft limit capped at 1024: 1200 authenticated HTTP requests, database writes,
snapshot refreshes and 200 scheduler iterations. All sampled operation boundaries have
zero open auth/main database or journal descriptors. Reinitialization preserves the
live session, call/SMS records, and both quick_check results remain ok.

Service tests cover 666, 1023, boundaries, invalid inputs, regular international numbers,
exact matching, CRUD and global/per-SIM whitelist precedence over provider/personal
blocks. Outgoing tests cover all three filtering modes, blocked destinations, original
short digits, AMI context and rendered SIP/WebRTC routes. Frontend regressions submit
short whitelist codes unchanged. Hardware/SIM calls have not been performed.

## Manual production rollout after review

This PR is based on current main (8a94d3d); production a4e5e33 predates the already-merged
localization PR. Review the complete production-to-target diff and preserve any private
IMS precondition patches before updating. Do not replace the production checkout or
force checkout over local changes. Take a consistent backup of the existing data and
configuration with the usual maintenance procedure; never delete or reset SQLite files.

After merging and safely updating the checkout, use the existing installation mode:
`sudo ./install.sh reload`. It rebuilds/restarts Control and WebUI and preserves data.
With the existing Engine image present, no Engine rebuild/recreation is required; do
not add --engines or --no-cache for this fix. No Engine source is changed. If the Engine
image is absent, the installer may build it: resolve that separately before maintenance
to avoid losing private Engine patches. Control/API access is briefly interrupted.

Verify the existing admin login/session and rules, then poll the UI and observe the
Control process's /proc/<pid>/fd counts over time (counts need not be zero during active
queries; they must return to a stable baseline). Check scheduler diagnostics without
publishing credentials. Test incoming Monitor then Enforce with a known allowed caller,
and manually test outgoing 666/1023 where supported by the carrier. No production
change or real-call verification is performed by this PR.

Rollback by safely restoring the previous application revision and rebuilding Control/UI,
preserving private patches and all data. No database rollback/migration is needed.
The old code reintroduces the connection leak, so rollback is temporary mitigation only.
