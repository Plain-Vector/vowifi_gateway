# Local validation — 2026-11-02

Changes were validated locally, without deployment or GitHub publication.

| Check | Result |
| --- | --- |
| Backend pytest suite | 73 passed (Python 3.14); includes actual FastAPI app callbacks |
| Python compileall (control/app and engine) | Passed |
| Shell syntax (install.sh, engine/entrypoint.sh) | Passed |
| npm ci and production Vite build | Passed (Node 22) |
| Browser smoke (headless Chromium) | Passed: CRUD, normalization, Monitor/Enforce lookup, 390 px mobile layout, no page errors |
| git diff --check | Passed |
| Docker image build / actual Asterisk / IMS calls | Not run: Docker socket access denied; no carrier/SIM test environment |
| GitHub Actions | Workflow prepared; not run remotely because branch has not been pushed |

Browser smoke used an isolated temporary SQLite database and two synthetic instances,
without connecting a SIM, starting an engine or accessing production data.

Existing frontend lockfile was retained. npm audit reports six pre-existing findings
(one moderate, five high) in baseline-browser-mapping, browserslist, nanoid, postcss,
source-map-js and vite. Dependency upgrades are outside this feature. Vite also reports
a bundle above 500 kB. Latest local FastAPI/Starlette emits an httpx TestClient
deprecation warning; all tests pass. CI targets Python 3.12 and Node 22.

Before production rollout, validate the patched Asterisk image, actual 603 response,
normal incoming/outgoing calls, SIP/WebRTC ringing, SMS, withheld IDs, failure-open
behavior and coexistence with the installation's custom precondition changes on a
test line. Initial engine recreation must be scheduled while idle.

Saracroche follow-up: public FR catalog and all five default phone lists were downloaded
successfully using the implemented Android-compatible adapter in a fresh temporary
SQLite database (132,610 merged rules; catalog hash/count verification passed). No
production data was used. Remote protocol tests use synthetic responses in CI and cover
opt-in, priorities, selection, cache reuse, integrity failures, licenses, URL boundaries,
HTTP errors and issued-credential handling. Local imports have separate validation,
atomicity and disabled-source tests. No database files were added to Git.

The follow-up browser smoke also passed against the real remote source in an isolated
temporary server: switch initially off, first connection/download, discovered list UI,
local matching, disabling matching, local-file import without implicit enable, and a
390 px viewport. No page JavaScript errors occurred.
