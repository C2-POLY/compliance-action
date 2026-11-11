# compliance-action

The GitHub Action only. `action.yml` stays at the root so that it is used as `uses: C2-POLY/compliance-action@v1`. The format it reads is defined in C2-POLY/compliance-spec.

## House rules

- Everything written in this repo is in English: code, docs, comments, issues, commits, PRs.
- Commit messages and PR titles follow Conventional Commits (`feat:`, `fix:`, `docs:`...). No AI attribution anywhere: no `Co-Authored-By` trailer, no "Generated with" line.
- **Examples use the fictional app « Bistro Booking » only**, a generic restaurant booking app. Never put a real company's name, data, services or repos in this public repo.
- No secret, token or personal data in code, fixtures, logs or examples.
- The project prepares documentation; it never claims to certify compliance.
- Issues live in this repo and in the GitHub Project « Compliance » (C2-POLY). Never `Closes`/`Fixes` in commits or PRs: use `Refs: #n`.
- Base branch: `main`. Every change goes through a pull request.

## Action rules

- Tokens are masked and never printed. The action never writes outside the paths the spec gives it.
