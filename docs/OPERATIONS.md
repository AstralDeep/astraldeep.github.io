# Community board operations

## Activate a task

Obtain owner approval of the draft first. Create an issue in its owning repository with a bounded problem, source evidence, scope, acceptance checks, and related dependencies. Apply `bounty`, exactly one of `points:25`, `points:50`, `points:100`, `points:200`, `points:400`, one `priority:P1`/`P2`/`P3`, and relevant `track:interoperability`, `track:voice`, `track:security`, `track:reusability` labels. Never put sensitive review findings in public task text.

The explicit public allowlist in data/config.json controls scope. Private or archived source repositories fail synchronization. A malformed point label also fails the whole build; fix the source issue rather than publish a partial board. Adding unrelated repositories requires review.

## Claim coordination

The `claim-request` issue form is the public entry point. The trusted main-branch workflow reads every request, freezes the accepted target and numeric GitHub account ID (`userId`) in state/claims.json, and commits decisions before posting acknowledgement. It does not trust mutable claim-body fields after acceptance. Source assignees override conflicts. One task per person applies to active central claims and current source assignments, compared by numeric account ID rather than username. A verified matching ID may refresh the displayed login after an account rename; reusing an old login never transfers a reservation. Missing, malformed or mismatched account identities fail synchronization closed. Do not invent IDs or replace them by editing the ledger.

Issue events trigger reconciliation; the schedule catches requests skipped when GitHub replaces a queued concurrency run. Expiry, closure, task completion/removal, and assignment conflicts release the reservation on the next successful reconciliation. Terminal requests never reactivate. Contributors must submit a new request for another reservation. The stored history is retained for audit.

The central bot uses only this repository's GITHUB_TOKEN. No organization PAT, GitHub App, source-repository workflow installation, product database, or release-token broker is needed. It cannot assign, modify, or merge in a source repository. Users and maintainers continue to use ordinary GitHub permissions there.

## Award record

After verifying task acceptance, submit a reviewed change to data/awards.json:

```json
{
  "issue": "https://github.com/AstralDeep/LETS/issues/123",
  "pr": "https://github.com/AstralDeep/LETS/pull/124",
  "userId": 12345678,
  "login": "contributor-login",
  "points": 100,
  "review": 123456789,
  "awardedAt": "2026-10-01T12:00:00Z"
}
```

Numbers above illustrate a schema, not real tasks or awards. `userId` is the contributor's required positive numeric GitHub account ID; verify it from the PR author returned by GitHub, never infer it from a username. `login` records the contributor's name when the award is entered. `review` is the GitHub numeric review ID, not an issue number. The approver must be in config.awardApprovers, independent from the PR author by account ID, and their APPROVED review must cover the final PR head and precede merge. The award date cannot precede merge. The source issue must retain its bounty and point labels and be closed with state_reason=completed. The PR must be merged in that repository and its author ID must equal `userId`.

Synchronization keeps the ledger's recorded `login` unchanged and adds `displayLogin` only to the generated public award snapshot, taking the current name from that ID-verified PR author. Leaderboard totals are grouped by `userId` and use the verified display name. Renaming an account neither splits its points nor transfers them to a new account that adopts its old name. Missing or malformed author IDs fail validation; there is no username fallback.

The selected approval review must deliberately attest that the PR satisfies the source bounty by including exactly one own line in this exact format, with the actual award issue URL:

```text
Bounty-issue: https://github.com/AstralDeep/LETS/issues/123
```

Keep the capitalization, single space and exact URL; do not indent the line, add trailing text, or include another `Bounty-issue:` line. Other review prose is allowed. A missing, wrong, duplicate or malformed attestation fails award validation. A PR description, ordinary issue mention, closing keyword or comment by another account does not substitute for this attestation in the selected independent APPROVED review. The reviewer remains responsible for judging task completion; the site verifies their explicit issue linkage and approval evidence, not the implementation's semantic correctness.

The initial configured award approver is `{ "id": 16158892, "login": "armstrongsam25" }`, verified through GitHub's public user API during setup. Entries in `config.awardApprovers` require both fields; the numeric ID grants approval authority and the login is a readable recorded label. A matching ID remains authorized after a rename, while another account reusing the label does not. Add other approvers through reviewed configuration changes after verifying their GitHub IDs. The public-source token cannot inspect private collaborator permissions; the explicit reviewed allowlist is the authority for credit approval.

One task and one PR can appear only once. Do not change points on credited issues. Corrections require a reviewed ledger change and explicit rationale in the PR/history. Source artifacts that are deleted or reviews that are dismissed cause subsequent validation to fail; investigate rather than silently drop credit.

## Deploy and recover

GitHub Pages must use Actions. `Community board` runs only from exact refs/heads/main. Pull-request checks have read-only permissions and never publish. The build allowlists site/ plus its generated board JSON; no review drafts, internal tooling, or credentials go into the artifact.

Use Actions → Community board → Run workflow to refresh immediately. A failed API request, rate limit, invalid label/award, or failed ledger push aborts deployment. The previous site remains available and shows its snapshot time; snapshots older than two hours display a stale warning. Do not interpret a failed sync as zero tasks or zero points.

Never force-push a reservation ledger after a concurrent main update. The push intentionally fails; rerun from the new main to recompute decisions. If a run persists a claim but fails before its comment, the next run posts the missing status receipt idempotently.

Keep the Actions token able to commit state/claims.json; a future ruleset must explicitly accommodate that narrow workflow or move state to a separately governed branch before enforcement. CODEOWNERS requests owner review but does not itself enforce a branch rule. Award/config changes remain a maintainer review obligation. The first setup does not alter organization-wide rulesets.

## Verification

`npm test` uses deterministic built-in Node tests, with a 90% line gate over all core API, synchronization, and claim/award model modules. Thin CLI/file wrappers and browser behavior are covered by build checks and live browser verification; this is not claimed as whole-site coverage. Product suites are separate from site checks. No remote mutations occur during unit tests.

To test real claim acceptance, first obtain approval to create a disposable bounty/claim pair. The initial launch deliberately publishes no synthetic tasks, claims, or leaderboard entries. Live API collection and Pages deployment can be verified before any issue is approved.
