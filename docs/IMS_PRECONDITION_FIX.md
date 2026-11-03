# Endpoint-scoped IMS SIP precondition support

## What is fixed

Some IMS peers require RFC 3312 preconditions in the initial INVITE. The existing
sysmocom Asterisk has the PRACK/UPDATE/QoS state machine, but its PJPROJECT validation
rejects `Require: precondition` before the dialog reaches that handler. This causes
420 Bad Extension while registration and some outgoing precondition exchanges work.

The tracked `engine/patches/asterisk/01_precondition_capability.py` now adds a
per-request/session PJPROJECT option and enables it in Asterisk only when both
`endpoint->volte` and `endpoint->precondition_supported` are true. The original Require
and SDP are retained. Unknown mandatory extensions still fail validation. Capability
advertisement on IMS session responses is scoped to that endpoint, with duplicate and
array-bound protection; global PJSIP capabilities are never changed.

No dialplan, route, SIM setting, SMS filtering, RP-ACK implementation, Control schema or
runtime data is changed. Existing QoS completion handling is used, not bypassed. The
pre-existing dedicated_bearer_up policy is not changed; synthetic tests do not establish
that a real carrier reserved resources or resolve the separate outgoing 403.

## Evidence and historical limits

The owner reports that the original clean fork worked before these later experiments,
without an extra precondition patch. Preserve that observation: the surviving images
do not establish the SIP headers of those earliest successful calls or explain their
entire history. An initial latent admission gap or a different incoming Require scenario
cannot be distinguished without an old SIP trace.

The later saved precondition-working/contacts6 images do contain an additional global
registration block and a build file named 01_precondition_capability.py. The same file
was found untracked in /srv/docker/vowifi/source, absent from source-new. Its compiled
registration is absent from before-sms-filter/sms-test/latest. This establishes the
saved-image difference without attributing authorship or claiming that the owner's
initial clean-fork success depended on that later file.

Upstream 92de0ff580cb8fedaddad6088475e030b32040e2 added global registration;
06a96d88d8e41a406a276af277d31f5dc83d151b reverted it because global advertisement affects
non-VoLTE endpoints. This implementation takes the old file's purpose into account but
uses per-endpoint admission instead of copying its global registration.

The Engine now pins the **same** inspected source base revisions:
Asterisk d231cb2c658545773fcd5eb9de787219b9ef6566, PJPROJECT
20537ab1e6beb2baf9ec15599e0217a601cf7ce5, plus the existing AMR cherry-pick. This is not an
Asterisk/PJPROJECT version upgrade. /opt/vowifi/ims-build-manifest.txt records these inputs
and hashes of the build patches/session binary. The patch validates all source anchors
before writing, is idempotent for a fully patched tree and fails on partial application.
Fedora packages/Python inputs are still independently versioned; this is not a claim
of fully bit-reproducible container images.

## Regression coverage

CI builds the actual Engine on amd64 and arm64 and boots isolated Asterisk with
synthetic loopback SIP endpoints. It checks:

- IMS Require: precondition admission, reliable 183 with QoS SDP, PRACK/200,
  UPDATE/200 with QoS sendrecv and completion of WaitForPrecondition before ringing.
- No premature 180 while mandatory QoS completion is outstanding; CANCEL/487/ACK cleanup.
- Unknown Require and mixed precondition/unknown tags remain 420 with correct Unsupported.
- Ordinary non-IMS and explicitly unsupported IMS endpoints remain 420 for precondition;
  support does not leak after an IMS call in the same running Asterisk.
- Ordinary IMS INVITE without mandatory preconditions still reaches its normal flow.
- Existing SMS filtering/RP-DATA/RP-ACK tests and fresh installation checks run unchanged.

The test-only global allow_sending_180_after_183=yes mirrors the existing production
PJSIP template; it is not a routing/configuration change. Backend tests remain enabled.
No test sends a call to production or requires a SIM/carrier account.

## Safe staged installation — only after review and explicit maintenance approval

Nothing below is executed automatically. Do not build/restart the active server merely
to inspect this PR. A Control/WebUI reload or docker restart of the existing Engine is
**not** sufficient: the SIP fix is compiled into a new Engine image, and an existing
container retains its original image ID after docker restart.

### 1. Build/test on a separate staging machine of the production architecture

Use a clean reviewed checkout containing this PR (after merge, use the reviewed main
commit). Preserve any local changes; do not force checkout/reset. From the repository:

```sh
git status --short
git rev-parse HEAD
IMSFIX_REV=$(git rev-parse --short=12 HEAD)
IMSFIX_CANDIDATE="vowifi/engine:ims-precondition-${IMSFIX_REV}"
docker build -t "$IMSFIX_CANDIDATE" engine
docker run --rm --network none --entrypoint python3 \
  -v "$PWD/tests/engine_precondition_smoke.py:/tmp/engine_precondition_smoke.py:ro" \
  "$IMSFIX_CANDIDATE" /tmp/engine_precondition_smoke.py
docker run --rm --network none --entrypoint python3 \
  -v "$PWD/tests/engine_sms_smoke.py:/tmp/engine_sms_smoke.py:ro" \
  "$IMSFIX_CANDIDATE" /tmp/engine_sms_smoke.py
docker image inspect "$IMSFIX_CANDIDATE" --format '{{.Id}} {{.Architecture}}'
docker run --rm --network none --entrypoint cat "$IMSFIX_CANDIDATE" \
  /opt/vowifi/ims-build-manifest.txt
docker image save -o "ims-precondition-${IMSFIX_REV}.tar" "$IMSFIX_CANDIDATE"
```

Transfer that tested archive to the server only after approval. Record the candidate
image ID, tag and source revision with the archive. Production is amd64 in the examined
installation; do not load an arm64-only candidate for it. The smoke tests override the
Engine entrypoint, have no production mounts/devices and need no external network.

### 2. Preserve the current SMS-capable rollback image before promotion

On production, in the approved maintenance window, first take the installation's
usual consistent config/data backup. Do not reset SQLite or change SIM configuration.
The image commands below do not overwrite data volumes. The existing installation uses
vowifi/engine:latest; verify the reference if the deployment has been customized.

```sh
docker inspect vowifi-engine-1 --format '{{.Config.Image}} {{.Image}}'
IMSFIX_PREVIOUS_ID=$(docker inspect vowifi-engine-1 --format '{{.Image}}')
IMSFIX_BACKUP="vowifi/engine:before-ims-precondition-$(date -u +%Y%m%dT%H%M%SZ)"
docker image tag "$IMSFIX_PREVIOUS_ID" "$IMSFIX_BACKUP"
docker image inspect "$IMSFIX_BACKUP" --format '{{.Id}}'
```

Record those two values outside the shell session. Preserve **all** existing image tags,
including October images. Rollback must use the just-saved current SMS-capable image,
not an older image that predates SMS filtering.

### 3. Load and promote the exact tested candidate, then recreate only the chosen SIM

Set the archive/tag variables to the values recorded on staging; they are not guessed
from the server's current Git revision.

```sh
IMSFIX_ARCHIVE=/path/to/the/tested/ims-precondition-REV.tar
IMSFIX_CANDIDATE=vowifi/engine:ims-precondition-REV
docker image load --input "$IMSFIX_ARCHIVE"
docker image inspect "$IMSFIX_CANDIDATE" --format '{{.Id}} {{.Architecture}}'
# Compare to the recorded staging ID before this promotion:
docker image tag "$IMSFIX_CANDIDATE" vowifi/engine:latest
```

Retagging does not alter running containers. In the authenticated WebUI use the normal
Start/Restart action for **SIM 1 only**. The existing Control start API recreates that
Engine from its saved configuration using the image tag, retaining the data/run/log
mounts and normal PIN preflight. It briefly interrupts calls/SMS and re-establishes the
SWu/IMS registration. Do not interrupt an active call. Other running SIMs keep their
existing image until individually recreated. Do not manually reconstruct docker run
arguments or change SIM credentials. No Control rebuild is required for this Engine-only
fix when Control is already at the deployed SMS/inheritance version.

Verify the running image ID matches the tested candidate:

```sh
docker inspect vowifi-engine-1 --format '{{.Image}} {{.State.Running}}'
docker exec vowifi-engine-1 cat /opt/vowifi/ims-build-manifest.txt
docker exec vowifi-engine-1 asterisk -rx 'module show like res_pjsip_session'
```

Then manually verify registration, one incoming Require: precondition call with proper
PRACK/UPDATE and ringing, outgoing 666/normal calls, allowed/blocked SMS and carrier
RP-ACK. A remaining outgoing 403 is a separate investigation; this PR does not promise
to resolve the carrier's internal X.int code.

The alternative installer command `sudo ./install.sh reload --engines` rebuilds on the
server and recreates all managed Engines. It is therefore NOT the recommended promotion
of an already-tested staging image and must not be used without explicit approval for
that broader interruption. Plain reload reuses an existing image but leaves running
Engine containers on their previous IDs; it is not an Engine deployment by itself.

### 4. Roll back without rebuilding or resetting data

Use the recorded rollback tag/ID (do not replace it with an October image):

```sh
IMSFIX_BACKUP=vowifi/engine:before-ims-precondition-RECORDED_TIMESTAMP
docker image inspect "$IMSFIX_BACKUP" --format '{{.Id}}'
docker image tag "$IMSFIX_BACKUP" vowifi/engine:latest
```

Use the same authenticated WebUI Start/Restart action for SIM 1 to recreate it from the
rollback image. Check its image ID and IMS/SMS state. No database/schema rollback,
configuration restore or deletion is required. Do not run reload --engines during
rollback: it would rebuild from source instead of using the saved image. Keep both
candidate and rollback tags until maintenance review is complete.
