# compliance-action

A GitHub Action that keeps a repo's compliance manifest in step with its code. It checks `.compliance/manifest.yaml` on pull requests, and on every merge sends the manifest and the commit SHA to the organisation's compliance repo, together with how far the documents lag behind the code.

The format of the manifest and of the compliance repo is defined in [compliance-spec](https://github.com/C2-POLY/compliance-spec) (v0.1 and v0.2). The schemas used here are copied from it into `schemas/`, see [Development](#development). Each file is validated against the schema of its own `spec_version`, so a v0.2 compliance repo can hold the v0.1 manifests of the repos that have not upgraded yet.

## How it fits together

```
service repo (bistro-api)                    compliance repo (bistro-compliance)
─────────────────────────                    ───────────────────────────────────
pull request  ── mode: check                 
push to main  ── mode: send ── repository_dispatch ──▶ mode: receive
                  validate, compute lag                 write services/bistro-api/{manifest,sync}.yaml
                                                        branch compliance/bistro-api + pull request
```

Nothing reaches the default branch of the compliance repo without a reviewed pull request: that review is the validation record.

## Service repo

Two jobs. `check` runs on pull requests and holds no secret. `send` runs only on pushes to `main`, in a protected environment.

```yaml
# .github/workflows/compliance.yml in bistro-api
name: Compliance

on:
  pull_request:
  push:
    branches: [main]

permissions:
  contents: read

jobs:
  check:
    if: github.event_name == 'pull_request'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<full-sha> # v5
        with:
          persist-credentials: false
      - uses: C2-POLY/compliance-action@<full-sha> # v1
        with:
          mode: check

  send:
    if: github.event_name == 'push'
    runs-on: ubuntu-latest
    environment: compliance # restricted to the main branch (Settings > Environments)
    steps:
      - uses: actions/checkout@<full-sha> # v5
        with:
          fetch-depth: 0 # the lag needs the full history
          persist-credentials: false

      - id: token
        uses: actions/create-github-app-token@<full-sha> # v2
        with:
          app-id: ${{ vars.COMPLIANCE_APP_ID }}
          private-key: ${{ secrets.COMPLIANCE_APP_PRIVATE_KEY }}
          owner: bistro-org
          repositories: bistro-compliance
          permission-contents: write

      - uses: C2-POLY/compliance-action@<full-sha> # v1
        with:
          mode: send
          compliance-repo: bistro-org/bistro-compliance
          token: ${{ steps.token.outputs.token }}
```

The secret (the App private key, or a token if you use one) lives in the `compliance` environment, whose deployment branches are limited to `main`: a pull request or another branch cannot read it.

**Token.** Prefer a short-lived GitHub App installation token, as above: scoped to the compliance repo only, with `permission-contents: write` and nothing else (`repository_dispatch` needs Contents write; `anchors.yaml` is read with the same permission). A fine-grained personal access token limited to the compliance repo with Contents: read and write also works, but it is long-lived and tied to a person. `send` never uses Pull requests: write. The token is masked in the logs and never printed.

## Compliance repo

```yaml
# .github/workflows/receive-manifest.yml in bistro-compliance
name: Receive manifest

on:
  repository_dispatch:
    types: [compliance-manifest]

permissions:
  contents: read

concurrency:
  group: compliance-${{ github.event.client_payload.repo }}
  cancel-in-progress: false

jobs:
  receive:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<full-sha> # v5
        with:
          persist-credentials: false # the action pushes with its own token

      - id: token
        uses: actions/create-github-app-token@<full-sha> # v2
        with:
          app-id: ${{ vars.COMPLIANCE_RECEIVE_APP_ID }}
          private-key: ${{ secrets.COMPLIANCE_RECEIVE_APP_PRIVATE_KEY }}
          owner: bistro-org
          permission-contents: write
          permission-pull-requests: write

      - uses: C2-POLY/compliance-action@<full-sha> # v1
        with:
          mode: receive
          token: ${{ steps.token.outputs.token }}
```

The workflow's own `GITHUB_TOKEN` can only read the compliance repo, so `receive` takes a token: it pushes the `compliance/<name>` branch and opens the pull request with it (through the environment of git, never in a command line).

**Verifying the sender.** A `repository_dispatch` payload is only a claim by whoever holds the sending token. By default (`verify-source: true`), `receive` checks it against the service repo before writing anything: `.compliance/manifest.yaml` at the sent `sha` must be byte-identical to the payload's manifest, and that `sha` must be on the service repo's default branch. On a mismatch nothing is written and the run fails. The `lag` is computed by the sender and cannot be checked; the pull request labels it "reported by the service repo".

This needs a token that can read the service repos (Contents: read on them), so install the App used by `receive` on the service repos too (with `owner` set and no `repositories` list, the token covers every repo the App is installed on). Setting `verify-source: false` skips both checks and writes "Source not verified" in the pull request body. That is acceptable only when every repo that can send is trusted, for example a single organisation where the sending tokens are held by the organisation itself and the reviewers read the diff of `services/**`.

**Concurrency.** The `concurrency` block serialises runs per sending repo, so two pushes in a row do not race on the same branch. Keep `cancel-in-progress: false`: a cancelled run could leave the branch half updated.

**Branch protection of the bot branch.** If a human pushed commits to `compliance/<name>` while its pull request is open, `receive` refuses to reset the branch and fails with a message: merge or close that pull request first.

## Generate the register

The `register` mode runs in the compliance repo. It reads `compliance.yaml`, `processings/*/processing.yaml`, `services/<repo>/{manifest,sync}.yaml` and `declared/<tool>/manifest.yaml` (strict YAML, each file validated against the vendored schema of its `spec_version`) and writes `documents/register.md`, plus `anchors.yaml`. What it writes depends on the `spec_version` of `compliance.yaml`:

- **`"0.1"`: the records of processing activities** (GDPR Art. 30(1)), in English, exactly as before.
- **`"0.2"`: the compliance dossier**, in English or French (input `language`; when it is empty, `organisation.language` of `compliance.yaml`, else `en`; the path is `documents/register.md` either way). In order: the organisation's identity (controller, DPO, representative, privacy contact, from `compliance.yaml`), the **actions** that close the open items (one row per action with its role, `Organisation`, `DPO` or `Developer`, its count and where it applies), then for each processing activity its records of processing (Art. 30(1)) and its DPO checks (legal basis and its detail, DPIA, information of persons, sensitive data, processor contracts), the AI features of the services the processings use with their AI Act role, risk and obligations, and **Outside the register**: the services and components whose controller is not the organisation. A processing without its own controller or DPO inherits the organisation's. A v0.1 manifest or processing file in a v0.2 repo is read with its v0.2 fields absent: each missing answer is an open item, never an error.

Then it resets the branch `compliance/register` from the base branch, commits as `compliance-action`, pushes it and opens a pull request `compliance: update the records of processing`, or updates the open one.

```yaml
# .github/workflows/register.yml in bistro-compliance
name: Register

on:
  push:
    branches: [main]
    paths:
      - "services/**"
      - "processings/**"
      - "declared/**"
      - "compliance.yaml"
  workflow_dispatch:

permissions:
  contents: read

concurrency:
  group: compliance-register
  cancel-in-progress: false

jobs:
  register:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@<full-sha> # v5
        with:
          persist-credentials: false # the action pushes with its own token

      - id: token
        uses: actions/create-github-app-token@<full-sha> # v2
        with:
          app-id: ${{ vars.COMPLIANCE_RECEIVE_APP_ID }}
          private-key: ${{ secrets.COMPLIANCE_RECEIVE_APP_PRIVATE_KEY }}
          owner: bistro-org
          permission-contents: write
          permission-pull-requests: write

      - uses: C2-POLY/compliance-action@<full-sha> # v1
        with:
          mode: register
          token: ${{ steps.token.outputs.token }}
          language: fr # optional: en or fr; by default organisation.language of compliance.yaml, else en
```

- **Prepared for review, not certified.** The pull request says that the document is prepared for review by the controller and its data protection officer and does not certify compliance. Rows with no source say `To complete` (`À compléter` in French) and need a person. Gaps are expected while people work, so the review starts with what is missing: the v0.1 register opens with an **Open items** section that lists them per processing activity; the v0.2 dossier opens with the **Actions** that close them. The front matter carries their count (`open_items`, and `actions` in v0.2), and the pull request body repeats the list as code spans (the open items in v0.1, each action with its role and count in v0.2; the body is in English whatever the language of the dossier). Open items are found from the source fields while the rows are built, never by reading the rendered text. The rules that fill each row, and the provenance of each value, are in [`templates/register/README.md`](https://github.com/C2-POLY/compliance-spec/blob/main/templates/register/README.md) of the spec; the templates are vendored in `templates/register/` (see `schemas/SOURCE.json` for the spec commit).
- **Merging records the anchors.** `anchors.yaml` holds the `sha` of the `sync.yaml` of each repo the document reads: in v0.1, each repo a processing refers to; in v0.2, each repo of `compliance.yaml` that has a `services/<repo>/` folder. Its `spec_version` is the one of the document. Once the pull request is merged, the next sync of a service counts its lag from that commit, so the lag of each service resets to 0.
- **Deterministic.** The same compliance repo and the same `generated-at` give the same bytes. When `generated-at` is not set, the action uses the commit time of the base branch of the compliance repo (`git log -1 --format=%cI`), never the clock, so a rerun on the same commit changes nothing. If nothing changed, the run logs it and stops: no branch, no pull request. A change of `language` changes the bytes, so it opens a pull request.
- **Fails closed.** A processing that points to a repo with no `manifest.yaml` or `sync.yaml`, to a tool missing from `compliance.yaml`, or to an unknown `data` or `recipients` id fails the run and writes nothing: a register that silently omits a service would look complete. In v0.2, so do a repo with a `services/<repo>/` folder but no `manifest.yaml` or `sync.yaml`, a declared tool with no manifest file, and a notice of `information.notices` that does not resolve. The v0.1 register refuses a v0.2 processing file: upgrade `compliance.yaml` first.
- **Safe writes.** The action writes only `documents/register.md` and `anchors.yaml`, refuses symbolic links, and pushes the token through the environment of git. It refuses to reset `compliance/register` if a human pushed to it while its pull request is open.
- **No loop.** The trigger paths do not include `documents/**` or `anchors.yaml`, so merging the register does not start another run. Use the same App as `receive` (or another one with Contents write and Pull requests write): pull requests opened with an App token trigger your checks.

## Protect the compliance repo

The compliance repo is where a human validates what the services declare. Protect it so that nothing can skip that review:

- A ruleset on the default branch: require a pull request with at least one human approval, block force pushes and deletions, require review from code owners.
- A `CODEOWNERS` file naming the DPO or a compliance team for `anchors.yaml` and `services/**` (and `compliance.yaml`, `processings/**`, `documents/**`).
- A ruleset on `compliance/**`: only the identity used by `receive` (the GitHub App) can create or update these branches.
- Under Settings > Actions > General, "Allow GitHub Actions to create and approve pull requests" is needed **only** if you use `GITHUB_TOKEN` to open the pull requests. Prefer the App token and leave it off. If you turn it on, the default-branch ruleset must still require approval by a human code owner, otherwise a workflow could approve its own pull request.
- Pull requests opened with `GITHUB_TOKEN` do not trigger other workflows; pull requests opened with an App token do, so your checks run on them.

## Pin your actions

Pin `C2-POLY/compliance-action` and every third-party action by full commit SHA (with the version in a comment, as in the examples) and let Dependabot propose updates:

```yaml
# .github/dependabot.yml
version: 2
updates:
  - package-ecosystem: github-actions
    directory: /
    schedule:
      interval: weekly
```

`@v1` works once `v1` is tagged, but a tag can be moved. In this repo, make the CI job (which fails if `dist/` is not what `npm run build` produces) a required status check on `main`.

## Inputs

| Input | Default | Meaning |
| --- | --- | --- |
| `mode` | required | `check`, `send`, `receive` or `register`. |
| `manifest` | `.compliance/manifest.yaml` | Path of the manifest in the repo. With `receive`, the path fetched from the service repo to verify the payload. |
| `compliance-repo` | | `owner/name` of the compliance repo. Required for `send`. |
| `token` | | Required for `send` (Contents write on the compliance repo), `receive` (Contents write and Pull requests write on the compliance repo; Contents read on the service repos if `verify-source`) and `register` (Contents write and Pull requests write on the compliance repo). |
| `verify-source` | `true` | `receive` only: check the payload against the service repo. See above. |
| `compliance-path` | `.` | Checkout of the compliance repo. Used by `receive` and `register`. |
| `generated-at` | commit time of the base branch of the compliance repo | `register` only: RFC 3339 date-time written in the register and in `anchors.yaml`. |
| `language` | `en` | `register` only: `en` or `fr`, the language of the v0.2 dossier. A v0.1 register stays in English. |
| `base-branch` | the repo's default branch | Branch whose pushes are sent (`send`); base of the pull request (`receive`, `register`). |

## Outputs

| Output | Meaning |
| --- | --- |
| `lag-count` | Commits since the last generated documents that touch the manifest's root `linked_files` (mode `send`). `0` when never documented or unknown. |
| `lag-status` | `in-sync`, `behind`, `never-documented` or `unknown` (mode `send`). |

## Modes

### `check`

Parses the manifest as strict YAML 1.2 (no tags, anchors, aliases or directives, one document) and validates it against the JSON Schema of its `spec_version` (v0.1 or v0.2; an unknown version is rejected) plus the cross-reference rules (unique ids, including component, notice and obligation ids; `data`, `component` and flow `processor` references). A missing file or an invalid manifest fails the job; each error is an annotation on the file with its path and message.

### `send`

Runs only on a push to the base branch (otherwise it logs "skipped" and succeeds). It validates the manifest, computes the lag, then sends a `repository_dispatch` of type `compliance-manifest` to the compliance repo with `repo`, `sha`, `manifest` (the YAML text) and `lag`. A manifest over 60 KB is refused (GitHub caps the payload at about 64 KB).

The lag is the number of commits `git log <anchor>..<sha> -- <linked_files>`, where the anchor is this repo's entry in `anchors.yaml` of the compliance repo:

- no `anchors.yaml`, or no entry for the repo: never documented (`anchor: null`, `count: 0`);
- anchor not in the local history (shallow clone, force-push) or manifest without root `linked_files`: `{status: unknown}`, with a warning asking for `fetch-depth: 0`.

### `receive`

Runs in the compliance repo on `repository_dispatch`. It checks that the repo is listed in `compliance.yaml` with a URL of the form `https://github.com/<owner>/<name>`, validates the manifest again, verifies it against the service repo (unless `verify-source: false`), refuses symbolic links on the way to the files, and writes only `services/<name>/manifest.yaml` and `services/<name>/sync.yaml` (whose `spec_version` is the one of `compliance.yaml`). It then resets the branch `compliance/<name>` from the base branch, commits as `compliance-action`, pushes that branch only (force-with-lease: it is a bot-owned branch) and opens a pull request `compliance: update <name> to <short sha>`, or updates the open one.

### `register`

See [Generate the register](#generate-the-register). Writes `documents/register.md` (the v0.1 register or the v0.2 dossier) and `anchors.yaml` on the branch `compliance/register` and opens a pull request.

## Disclaimer

This action prepares documentation. It does not certify compliance and does not replace a Data Protection Officer.

## Development

```
npm install
npm run all        # typecheck, test, build
```

`dist/` is committed (the runner executes `dist/index.js`): rebuild it with `npm run build` and commit the result; CI fails if it is stale.

The schemas in `schemas/v0.1/` and `schemas/v0.2/` and the templates in `templates/register/` (`register.md.tmpl` for v0.1, `register.en.md.tmpl` and `register.fr.md.tmpl` for v0.2) are vendored. To update them from a checkout of compliance-spec:

```
node scripts/sync-schemas.mjs ../compliance-spec
```

`schemas/SOURCE.json` records the spec commit they come from. The cross-reference checks of the spec's `validate.mjs` are ported in `src/schema.ts`. The v0.1 register is built in `src/register.ts`, the v0.2 dossier in `src/dossier.ts`; their golden outputs for the Bistro Booking example are `tests/fixtures/bistro-booking/documents/register.md` (v0.1) and `tests/fixtures/v0.2/bistro-booking/documents/register.md` and `register.fr.md` (v0.2), which the spec copies byte for byte.

## Licence

[Apache 2.0](LICENSE)
