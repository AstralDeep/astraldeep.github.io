# Community board operations

## Activate a task

Obtain owner approval of the draft first. Create an issue in its owning repository with a bounded problem, source evidence, scope, acceptance checks, and related dependencies. Apply `bounty`, exactly one of `points:25`, `points:50`, `points:100`, `points:200`, `points:400`, one `priority:P1`/`P2`/`P3`, and relevant `track:interoperability`, `track:voice`, `track:security`, `track:reusability` labels. Never put sensitive review findings in public task text.

The explicit public allowlist in data/config.json controls scope. Private or archived source repositories fail synchronization. A malformed point label also fails the whole build; fix the source issue rather than publish a partial board. Adding unrelated repositories requires review.

## Automatic awards

An approved bounty earns its published points when a PR successfully merges into exact `main` and GitHub records that PR as closing the issue as completed. Credit goes to whoever opened the PR, including self-merges. Contributors include `Closes #N` in the PR description. No reservation, assignment, configured merger, extra points review, form, or manual ledger entry is required. Product CI, review, qualification, and release protections remain authoritative.

The coordinator verifies GitHub's latest `ClosedEvent.closer`, the same-repository PR URL and base repository, `base.ref === main`, immutable numeric author and merger identities, ordered submission/merge/closure times, final head and merge SHAs, and closure event ID. A manually closed issue, ordinary mention, arbitrary PR description, unmerged PR, or merge into another branch cannot earn an award. A fork contribution is eligible when its base is the configured source repository's main.

New records use `policy: main-merge` and retain the task, PR, author and merger IDs, points, `baseRef`, submission/merge/closure/award times, head and merge SHAs, and closure identity. The workflow appends verified awards to `data/awards.json` on `community-state` before Pages publication. Retries reverify saved evidence and cannot award twice. One task and one PR earn one award; a PR closing multiple eligible bounties fails synchronization until its award scope is reviewed.

Every sync revalidates recorded awards. Current display names come from the ID-verified PR author; the ledger's original login and evidence remain unchanged. Missing or changed evidence, reopened credited issues, or changed credited point labels fail deployment and preserve the previous site. Corrections require reviewed changes and an explicit reason.

## Preserved history and rollout

The reservation command system is retired. Delete `claim-reply.yml` from all five sources so historical action pins stop processing comments or assigning issues. The coordinator does not scan commands, notify claimants, or mutate source assignments. Existing source comments and assignments remain GitHub history and impose no new-award prerequisite.

`state/claims.json` and `state/claim-protocol.json` remain archived, byte-preserved files on the data-only state branch. Persistence rejects any change to their bytes. They are excluded from the generated board. Historical `maintainer-merge` awards keep their original reservation/assignment evidence and merger requirements; historical review-based corrections retain their exact-head independent review and attestation checks. `historicalAwardApprovers` in config exists only for rechecking these older records and does not authorize new points. The [2026-10-01 missed-claim correction](CREDIT-RECOVERY-2026-10-01.md) remains a historical record.

The first successful new coordinator sync can credit previously missed completed bounties when their main merge and GitHub closure evidence qualify. Never manufacture closure evidence, backdate reservations, change published points to fit a record, or seed synthetic achievements.

## Deploy and recover

GitHub Pages uses Actions. `Community board` runs protected main code only from exact `refs/heads/main`. Pull-request checks have read-only permissions and never publish. The build allowlists `site/` and generated board JSON; review drafts, internal tooling, and credentials stay outside the artifact.

Use Actions → Community board → Run workflow to refresh immediately. Source repositories require no new award workflow or cross-repository write credential: the coordinator polls all five public sources every five minutes. GitHub may delay scheduled jobs. The browser refreshes the board every minute while visible and preserves its last snapshot on failure. Snapshots older than two hours show a stale warning.

A failed API request, rate limit, invalid label or award, or state-write race aborts publication. Never interpret a failed sync as zero tasks or zero points. Never force-push state: rerun against its current head. An applied write with a lost response recovers from the next immutable snapshot and does not duplicate points.

## PR CI notifications

The commit-pinned `actions/pr-ci` action reports qualification results in the five core source repositories. Each repository's separate `pr-ci-notifications.yml` controller runs on completion of its monitored workflows, with scheduled recovery every 15 minutes and an exact-main-only manual dry-run option. It uses only `actions: read`, `issues: write`, and `pull-requests: write` with the built-in token. It checks out no repository code, executes no PR input, downloads no artifacts, and holds no secrets, OIDC, approval, merge, publishing, or release authority.

First-time contributors still need maintainer approval to start CI. This controller never approves or reruns workflows. On a current-head failure it tags the PR author and links failed jobs and steps, asking them to fix the CI issues and push changes. Later failure details update the same trusted bot receipt. Older heads and superseded attempts cannot generate notifications. A successful rerun marks the failure receipt resolved.

Review readiness requires successful current-head PR-event runs from all applicable qualification workflows: Deep CI, Plane CI, Primitives CI qualification, Projection CI plus path-applicable Android/Apple lanes, and both LETS ci/security. Workflow paths come from the PR base commit; complete renamed/removed file inventories determine native applicability. Missing, pending, approval-required, skipped, neutral, or unsuccessful runs cannot qualify. Fork runs with an empty `pull_requests` list are matched using repository IDs, branch and head SHA.

Non-draft successful PRs request review from the ID-verified `armstrongsam25`. If a review is already pending, a new-head success receipt tags him instead. One success notification is sent per head SHA; repeated completion and recovery events stay silent. Sam's own PRs are excluded by numeric account ID `16158892` across completion, scheduled recovery, and manual runs. The controller does not inspect their CI, create or edit their notification comments, or request reviews; existing bot receipts remain unchanged. Product CI and required checks still run normally. This notification is an invitation to review, not approval to merge. Provider errors fail the controller while allowing other open PRs to reconcile; the next recovery run retries.

## PR triage

The separate commit-pinned `actions/pr-triage` controller requests a real issue link or a
concrete `Standalone:` explanation on non-draft PRs. Scheduled and manual reconciliation
uses one trusted bot comment and `triage:needs-context`; supplying context resolves both.
An issue number that is actually another PR does not satisfy the issue check. Missing links
never close a PR automatically.

A maintainer with current write, maintain, or admin permission can apply a reviewed closure
by posting `/astral-triage close <40-character head SHA> <reason>` and a new paragraph with
at least 40 characters of concrete evidence. Reasons are `no-op`,
`unsupported-completion`, `duplicate`, and `superseded`. Review the whole current diff and
acceptance scope first. Useful partial work should be repaired or narrowed, and duplicates
must have no useful remaining delta. Size, age, author, AI use, missing links, failed CI, and
conflicts alone are not closure reasons.

The controller runs only from exact `refs/heads/main`, has only `issues: write` and
`pull-requests: write`, checks out no repository code, executes no PR input, downloads no
artifacts, and uses no secrets, OIDC, contents-write, approval, rerun, merge, or release
authority. It re-reads the provider comment, verifies maintainer identity/permission, refuses
edited comments and stale heads, and records the decision before closing. A head that changes
during closure is reopened. GitHub's closure API has no atomic head precondition; provider
rechecks and conservative reopening are compensating controls. An unverifiable close reply
or post-close readback attempts a verified reopen and reports any remaining uncertainty.
A command receipt is never replayed, including after manual
reopening or an API failure; review again and post a fresh command to retry. Task issues,
branches, and points remain unchanged. Each source's `.github/PR_TRIAGE.md` owns the review
policy and maintainer procedure.

## Verification

`npm test` uses deterministic built-in Node tests with a 90% line gate over the API, state, synchronization, award model, and PR CI notification modules. Thin CLI/file wrappers and browser behavior are covered by build checks and browser verification; this is not whole-site coverage. Product suites are separate. Tests perform no remote mutations.

Before publishing run `npm test`, `npm run check`, `npm run build`, inspect desktop and mobile views, and inspect the generated artifact. A read-only `npm run sync` uses current `community-state` history and real public provider evidence without updating any ledger. Do not create disposable public tasks or merge test PRs without user authorization.

## Branch protection and durable state

Protect `main` with pull requests, zero required approvals, the GitHub Actions `test` check, blocked deletions, and blocked force pushes. Auto-merge may be enabled; failing CI still blocks merges.

The main-only coordinator loads all three history files from one verified immutable `community-state` commit, rejects unexpected tree entries or executable files, and verifies the current head before a fast-forward data-only update. Only award bytes may change. It confirms the committed bytes before Pages publication. Main remains PR-controlled; workflows never check out or execute state-branch code.

Each history file is bounded to 1,000,000 UTF-8 bytes before any write, within GitHub's base64 Contents API support. Exceeding that limit fails before advancing the branch. Preserve history and review a storage migration rather than truncate it. Main copies are historical migration snapshots: never replace the live state branch with them. Block deletion and force pushes of `community-state`; its narrow normal data commits remain writable by the trusted coordinator. Corrections to live state require operator review.
