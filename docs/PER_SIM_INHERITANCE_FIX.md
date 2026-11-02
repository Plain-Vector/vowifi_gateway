# Per-SIM blocking inheritance correction

## Cause and behavior

The settings resolver correctly merged defaults, global values and explicit per-SIM
fields, then forcibly reset call/SMS mode to Disabled whenever the corresponding global
mode was Disabled. Missing global sms_mode defaults to Disabled, so a perfectly valid
SIM-only SMS Enforce configuration was silently masked in the Engine snapshot.

The resolver now stops after ordinary per-field merging:
`defaults < stored global settings < explicit per-SIM settings`.
Call mode and SMS mode inherit independently, including explicit Disabled overrides.
Absent or null per-SIM fields inherit (the existing PUT replacement contract is unchanged).
Global rules continue to apply alongside that SIM's personal rules; a whitelist still
wins within its communication type. No rules are moved across scopes.

The optional Saracroche update eligibility check also previously returned early for
Global Disabled. It now respects an opted-in scope whose effective **call** mode is
active, including a per-SIM override. SMS-only activation never enables provider updates.
This changes the local eligibility check, not the provider protocol or download code.
No network requests are used in the regression tests.

WebUI already merges the saved global values with the editable per-SIM draft. The
runtime-only masking warnings were incorrect after this fix and are removed. Saved
status continues to use API effective settings, while the form previews unsaved edits.
The API, Control lookup and snapshots use the same effective resolver. Engine matchers
already consume the snapshot modes without a second global override, so no Engine code
or image change is needed.

## Validation

Regression coverage exercises the six Disabled/Monitor/Enforce inheritance cases for
both call and SMS mode through authenticated API reads/writes, on-disk Engine snapshots
and the existing Engine lookup. The supplied production configuration is reproduced,
including an omitted global sms_mode, per-SIM Enforce and a both-channel scoped rule.
Tests verify scope isolation, explicit Disabled, independent modes, global rules,
whitelist priority, unchanged stored JSON/rule IDs/history/auth sessions after init,
and opt-in provider eligibility. WebUI tests check selectors and saved status for both
SIMs, override reset and independent modes. Existing calls/SMS/FD tests remain enabled.

## Safe manual upgrade

No deployment is performed by this PR. After review and merge, in the existing
production checkout:

```sh
git status --short
# Review/preserve any production-local IMS patches before updating; never reset them.
git fetch origin
git merge --ff-only origin/main
sudo ./install.sh reload
```

If fast-forward fails or Git reports overlapping local changes, stop and review the
checkout; do not force checkout/reset. With the existing patched Engine image present,
the ordinary existing-mode reload rebuilds/restarts Control and WebUI, preserves runtime
data, and republishes each snapshot during blocking.init. Do not add --engines or
--no-cache. No Engine recreation/rebuild, SIM reconfiguration, database migration,
credential reset or rule edit is required. If the old Engine image is absent, resolve
that separately before invoking reload so the installer cannot build an unreviewed
replacement over private patches. Control/API access is briefly interrupted.

After reload, GET /api/blocking/settings?scope=1 must show the configured SMS Enforce in
effective settings; SIM 2 without an override must remain Disabled. Verify each existing
instances/<id>/run/blocking.sqlite settings table matches that API response. Test one
allowed/whitelisted SMS and one chosen blacklist match on the intended SIM. Historical
SMS are not retroactively filtered or removed. Carrier/production tests are manual.

Operational stop now requires disabling the global default **and** every explicit
per-SIM mode override (or clearing overrides to inherit Disabled), separately for calls
and SMS. Global Disabled is no longer a master stop. Rollback to ce23f1a needs only the
old Control/UI revision and a normal reload, preserving private patches/data; it
reintroduces the inheritance defect. No schema/data rollback is needed.
