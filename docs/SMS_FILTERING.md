# Incoming SMS filtering

## Rules and modes

Personal blacklist and whitelist rules have `communication`: `calls`, `sms` or `both`.
Migration 5 adds a NOT NULL constrained column with default `calls`; existing rules
keep their IDs, scope, descriptions, enabled state and call behavior. SMS defaults to
Disabled. No databases, sessions, credentials, history, provider data or SIM config are
reset. The migration is additive, idempotent and transactional, including its version
marker and new tables. Failed migration rolls back; retry with the corrected code.

The existing unique key `(scope,kind,number,match_type)` is retained: one row owns its
channel selection. A duplicate POST returns 409, including when only communication
changes; edit the existing row with PUT. Legacy PUT without communication retains the
existing value. New POST without it defaults to calls. Exact service codes (2–6 ASCII
digits, starting 1–9), ordinary E.164 normalization and explicit prefixes are supported.
Personal whitelist precedence applies separately within each channel, across global and
per-SIM scope. A calls-only whitelist does not allow an SMS-only blacklist match.

Quick block/unblock dialogs are available in call history and SMS conversations, with
context defaults Calls only / SMS only. Quick block unions selected channels into the
same exact blacklist row; unblock subtracts them and removes an empty row. It modifies
only the selected SIM's exact blacklist entry. Global entries, prefix rules and all
whitelists remain untouched. If a matching row is disabled, quick block returns a
localized conflict instead of enabling unrelated channels; edit it explicitly in Personal
lists. The app has no existing contact-blocking action to extend.

`sms_mode` inherits global/per-SIM settings independently of call `mode`. Global Disabled
is an emergency stop for its own channel only. Monitor evaluates and delivers; Enforce
suppresses personal blacklist matches unless personally whitelisted. ARCEP, Saracroche,
withheld/unavailable call policies never participate in SMS evaluation. Alphanumeric or
unusable sender identities fail open unless a supported normalized number can be matched.

## Delivery architecture and privacy

Control publishes two indexed tables in the atomic, filter-only snapshot: `rules` contains
call rules/provider data; `sms_rules` contains only personal SMS rules. Existing Engine
call matchers can read the new snapshot without treating an SMS rule as a call rule.

The incoming `volte_ims_msg` context initializes SMS_SUPPRESS=0, runs the local
`sms_filter.py` AGI and branches before any body log, `sms_in` callback or MessageSend.
Lookup uses the read-only immutable snapshot, a 50 ms SQLite busy timeout, 100 ms SQL
progress deadline and 500 ms total AGI deadline. Connections close explicitly. No HTTP,
provider lookup or SMS body is involved in the synchronous decision. Missing, corrupt,
old or unavailable snapshots and AGI failures preserve normal delivery. Old snapshots
without sms_rules are treated as containing no SMS rules.

Only the suppressed branch emits `sms_filter`: its encoded report contains sender,
rule, decision, mode, time and a random engine callback ID, never a body. Allowed/Monitor
messages follow the existing body log, one `sms_in` callback and one MessageSend per SIP
client. Control records body-free filtering history and stores/delivers normal SMS once.
If an sms_in report incorrectly claims suppression (e.g. a failed AGI command handoff),
Control honors continued delivery and records fail-open status.

`blocking_sms_events` is separate from the ordinary inbox and call history. It records
non-Disabled evaluations, including Monitor matches and whitelisted/no-match decisions;
filter by SIM and allowed/suppressed, with pagination. `sms_delivery_receipts` atomically
claims a callback ID with the normal inbox insert, so retrying that callback cannot
create another inbox record/WebSocket/push notification. Receipts expire after 30 days;
this is callback idempotency, not carrier-level SMS deduplication. Distinct messages with
identical sender and body are deliberately delivered. Suppressed events never call the
normal inbox/WebSocket/push path. Normal SMS persistence failures roll back the receipt.

Ordinary suppressed-message logs contain no body. Explicit Asterisk debug/SIP packet
logging is a pre-existing transport diagnostic mechanism which can contain raw PDU/body
before policy evaluation; keep it disabled during normal operation and redact private
captures before sharing. This PR does not change that low-level diagnostic mechanism.
Engine notification delivery remains best effort with a local event journal; this feature
does not add a durable transactional WebSocket/SIP delivery queue.

## IMS acknowledgements and repeat-delivery investigation

Reference: [3GPP TS 24.341 / ETSI TS 124 341, sections 5.3.2.3–5.3.2.4](https://www.etsi.org/deliver/etsi_ts/124300_124399/124341/12.07.00_60/ts_124341v120700p.pdf).
An incoming SMS-over-IP delivery requires both the SIP response and an RP delivery
report; accepting a SIP MESSAGE alone is not an RP acknowledgement. The report is a
separate MESSAGE to the IP-SM-GW, carrying RP-ACK/RP-ERROR and In-Reply-To correlation.

Audited implementation: [sysmocom/20.7.0 res_pjsip_messaging.c](https://gitea.sysmocom.de/sysmocom/asterisk/src/branch/sysmocom/20.7.0/res/res_pjsip_messaging.c)
and existing `engine/patches/asterisk/mt_rpack_routing.py`. The decoder recognizes
application/vnd.3gpp.sms RP-DATA, extracts the RP reference and decodes the TPDU. The
receive handler sends SIP 200 for SMS (202 for plain text), queues the Message-channel
dialplan, and calls send_rpack for a decoded RP reference. This is independent of the
user inbox policy; dialplan suppression neither forges an acknowledgement nor returns
RP-ERROR. RP-ACK acknowledges gateway transport receipt, not delivery to each local
SIP client. This feature does not change incoming C transport code, outgoing SMS submit
reports, IMS registration, SIP calling, PCSC or media.

The existing RP-ACK patch targets incoming P-Asserted-Identity (fallback From), pins the
arrival transport, routes FQDN identities through the connected peer, supplies registration
service/security information and correlates In-Reply-To to the incoming Call-ID. Its
comments describe prior routing/DNS failures as one source of repeated delivery. Those
comments do not prove the cause on this owner's carrier.

Confirmed production evidence supplied: 77 old/four new ordinary inbox records and
independent sms_in journal events for repeated voicemail text from +33162323065. This
shows repeated dialplan deliveries rather than a WebUI-only duplicate. It does not
identify the sender's operator or establish malicious sending or a particular ACK bug.
No live production SIP trace or RP-ACK response was supplied, so the underlying repeat
cause remains unresolved. Blocking the number is an independent optional inbox policy,
not a claimed acknowledgement fix.

PJSIP handles retransmission transaction keys before dialplan queueing; the receive
source explicitly avoids queueing when a duplicate transaction cannot create a response.
Incoming headers (including Call-ID/CSeq) are exposed to MESSAGE_DATA, and SMS_SMSC_TIMESTAMP
is available after TPDU decoding. Current sms_in journal entries do not include those
original transport identifiers. RP reference is an 8-bit field reused across messages;
SMSC timestamp or sender/body alone is not a globally unique message identifier. Reliable
same-transaction replay suppression may use full SIP transaction identity with a bounded
lifetime, but fresh Call-ID/CSeq deliveries cannot safely be collapsed based on content.
No speculative carrier replay suppression is added.

For the next repeat incident, collect a short private/redacted SIP trace spanning the
incoming MESSAGE and outgoing RP-ACK: Content-Type, Call-ID, CSeq, Via branch, RP reference,
In-Reply-To, target/Route/transport and final response/timeouts. Compare repeated
transactions vs fresh deliveries, RP-ACK references/targets, DNS/transport failures and
registration/tunnel timing. Review whether the actual production image contains the
existing RP-ACK patch and all private IMS patches. Do not reset data or change routing
based solely on the sender number.

## Validation and deployment

Tests cover channels/modes/scopes, exact service codes, prefix and whitelist precedence,
provider exclusion, migration/idempotency/rollback, callback replay, body-free events,
inbox/notification suppression and fail-open behavior, FD lifetime and existing calls.
Frontend coverage includes context defaults, block/unblock choices, failure handling,
RU/FR/EN history/dialogs and language switching. CI adds a standalone test inside each
built Engine image using an actual Asterisk Message channel and synthetic RP-DATA. It
checks SIP responses/RP-ACK and local SIP delivery under Disabled/Monitor/Enforce/corrupt
snapshot. This is not a real SIM/carrier IMS interoperability test.

Manual upgrade after review (no automatic merge/deployment):

1. Schedule maintenance; SMS/calls/registration are interrupted while Engines are
   recreated. Save a consistent data/config backup, current application revision and
   current Engine image ID/tag. Review `git status` and preserve/private-review all
   production IMS patches; do not force checkout, reset databases or replace a dirty
   production checkout. Merge/update the fork only after review.
2. Keep SMS mode Disabled initially. Update Control/UI with the normal existing-mode
   `sudo ./install.sh reload`; this preserves data and migrates old rules as calls-only.
   This step alone DOES NOT install SMS suppression into an existing Engine container.
3. Review/reapply private Engine patches onto the updated sources before rebuilding.
   Changed Engine files: Dockerfile (installs sms_filter.py), sms_filter.py (new),
   blocking_match.py (channel-aware matching), call_filter.py (shared optional channel
   parameter and explicit connection close), templates/extensions.conf.j2 (incoming
   SMS gate). No Asterisk C/RP-ACK/PCSC/media patches are changed by this PR.
4. During the maintenance window run `sudo ./install.sh reload --engines` in the existing
   mode. It rebuilds the Engine image and removes/recreates Engine containers; SIMs
   must reconnect/re-register. Preserve the old image for rollback. Verify installed
   sms_filter.py and the rendered volte_ims_msg context on each SIM. Mixed/old Engines
   continue old SMS delivery; do not enable Enforce before all Engines are updated.
5. Verify existing admin login, users/session behavior, SIM config, call/SMS history,
   rules/provider state and stable Control FD counts. Test outgoing/incoming calls and
   outgoing SMS. Enable SMS Monitor globally, then optional per-SIM Enforce using
   synthetic/test senders: confirm allowed/whitelisted SMS reach inbox and SIP clients,
   blocked SMS appear only in body-free filter history, and carrier RP-ACK is accepted.
   Verify both service numbers and regular numbers where the carrier supports them.

Operational rollback: set global SMS mode Disabled and retain the updated Control/UI.
This stops SMS filtering and preserves all records/rules. Reverting to an older Engine
image is compatible with new Control snapshots because call and SMS tables are separate;
recreate Engines in maintenance, preserving private patches and accepting interruption.
Do not blindly downgrade Control after adding SMS-only rules: older Control ignores the
communication column and could apply SMS-only rows to calls. Before such a downgrade,
while Control is stopped, make a consistent backup and disable (do not delete) SMS-only
personal rows, recording their IDs/enabled states for later restoration; combined rows
keep their intended call effect. Review this data change explicitly. Never restore an
old whole database over newly received messages. No destructive down-migration is shipped.
