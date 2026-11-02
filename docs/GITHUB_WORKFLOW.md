# Working on the Plain-Vector fork

The development repository is https://github.com/Plain-Vector/vowifi_gateway.
The original project is https://github.com/pagecat/vowifi_gateway.

Local setup for this checkout:

* origin: Plain-Vector fork (fetch/push destination).
* upstream: pagecat original (fetch only; push URL deliberately disabled).
* Feature branch: codex/call-blocking, based on origin/main at e371984.
* Author: Plain-Vector, 38751544+Plain-Vector@users.noreply.github.com (no private email).
* Per-repository configuration: fast-forward-only pulls, prune stale remote refs,
  simple pushes to origin and zdiff3 conflict display. Global Git settings are unchanged.
* GitHub CLI is installed locally at ~/.local/bin/gh. Authentication requires the
  owner's GitHub login; never put a token in a remote URL or commit it.

The GitHub integration in Codex is connected as Plain-Vector; fork access has been
verified. It can assist with repository/PR inspection and future publication. Git CLI push authentication must also be configured; an integration
connection alone is not proof that local Git can push.

For GitHub CLI browser authentication (run interactively as the owner):

```sh
~/.local/bin/gh auth login --hostname github.com --git-protocol https --web
~/.local/bin/gh auth setup-git
~/.local/bin/gh auth status
```

Normal work:

```sh
git status --short --branch
git fetch origin
git fetch upstream
# Review upstream changes before merging them into the fork; preserve local IMS patches.
# Work and commit on codex/* feature branches, not directly on main.
python -m pytest -q
npm run build --prefix webui
git diff --check
```

When ready to publish this branch (not performed automatically):

```sh
git push --set-upstream origin codex/call-blocking
~/.local/bin/gh pr create --repo Plain-Vector/vowifi_gateway --base main --head codex/call-blocking
```

Use the PR template, report tests and hardware limitations, and inspect the Validate
gateway checks. The workflow runs on pushes to main/codex branches and pull requests.
It has read-only repository permissions and no deployment steps. Remote checks do not
run until the branch is pushed. Do not force-push shared branches. Merge through a PR
after review; deployment remains a separate manual maintenance operation.

Recommended repository setting, to be applied after owner authorization/access:
protect main, require pull requests and the backend/frontend checks, and prevent
force-pushes/deletion. These server-side settings are not configured by local Git.
