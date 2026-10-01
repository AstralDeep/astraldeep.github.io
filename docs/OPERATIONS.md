# Community board operations

## Activate a task

Obtain owner approval of the draft first. Create an issue in its owning repository with a bounded problem, source evidence, scope, acceptance checks, and related dependencies. Apply `bounty`, exactly one of `points:25`, `points:50`, `points:100`, `points:200`, `points:400`, one `priority:P1`/`P2`/`P3`, and relevant `track:interoperability`, `track:voice`, `track:security`, `track:reusability` labels. Never put sensitive review findings in public task text.

The explicit public allowlist in data/config.json controls scope. Private or archived source repositories fail synchronization. A malformed point label also fails the whole build; fix the source issue rather than publish a partial board. Adding unrelated repositories requires review.

## Claim coordination

Contributors post `/claim` on its own first nonblank line in a new comment on the source bounty issue. There is no central form. A new `/unclaim` comment on the same issue releases that account's reservation. Commands are case-insensitive; quoted commands, code blocks, inline mentions, arguments, bots and pull requests are ignored.

The main-only coordinator collects public source comments, compares stable numeric account IDs across all five repositories, and commits exclusive decisions in `state/claims.json` before a source bot can confirm them. Source commands use `comment:<repository>:<comment-id>` keys; legacy central requests retain their numeric keys. Target, command, command time, numeric user ID and immutable user node ID are frozen when first recorded. Editing or deleting a processed comment cannot transfer, renew, or erase its reservation. A repeated claim refers to the existing reservation and does not extend its expiry. A valid later `/unclaim` also cancels an older command discovered during recovery.

`state/claim-protocol.json` starts with a null activation time. The first trusted main reconciliation sets `enabledAt` and persists it in the same commit as the ledger. Later runs preserve it. This bounds scheduled catch-up: historical comments from before activation do not unexpectedly claim tasks. Previously active form reservations retain their original IDs and expiry. Their source reply and assignment can be reconciled in place; closing the old central request still releases them. The retired form is removed, while legacy request history and notifications remain supported.

The central token only reads the five public sources and writes this repository. Each source uses its own built-in token with `issues: write` to project a committed decision onto its own issue. No organization PAT, GitHub App, browser token, product database or credential broker is introduced. The coordinator is the single serialized owner of one-task-per-person and one-person-per-task decisions.

Both central and source recovery are scheduled every five minutes. Confirmation can require more than one cycle, and GitHub can delay or drop scheduled runs. The initial receipt says queued; contributors wait for **Reserved** on the source issue. The browser refreshes its published board snapshot every minute while visible and preserves the last snapshot if refresh fails. A source receipt reads coordinator `main` through GitHub's API, not a cached Pages snapshot.

## Source replies and assignments

Install `actions/claim-reply` with an exact commit pin. Each `claim-reply.yml` handles created/edited human comments, scheduled recovery and manual recovery. All runs share one repository-level concurrency group, with `cancel-in-progress: false`, an exact `refs/heads/main` job guard, a bounded timeout and only `issues: write`. They check out no repository code and run no contributor code. State files are read from one verified coordinator commit; relevant reservations are re-read before assignment mutations.

There is one trusted bot receipt per source command, identified by numeric bot identity and a bound marker. The bot edits that receipt through pending, reserved, rejected and ended states. Old guidance markers remain in updated receipts so earlier action pins still deduplicate them. A receipt records the first observed command time; subsequent edits cannot reorder an already registered command. Scans are bounded and complete or fail closed, and API failures fail the run. Scheduled recovery catches replaced queued events and restores a missing receipt from frozen ledger metadata even if the original comment was edited or deleted.

Assignments use immutable GitHub node IDs, verified against the claimant's numeric ID. An accepted reservation is acknowledged truthfully even if its source assignment fails: the reply says assignment pending and recovery retries without another comment. Assignment intent is saved before mutation; the bot's issue event ID then records ownership. This allows recovery if assignment succeeds but the receipt update fails.

Expiry, `/unclaim`, completion, task removal and conflicting source assignments end a reservation. Only an assignment made by this automation for that exact reservation may be removed automatically. A pre-existing manual assignment, a later human reassignment, or a maintainer's removal takes precedence. The bot never repeatedly reassigns a task that a maintainer unassigned. Replacement commands wait for stale bot-owned assignment cleanup instead of being permanently rejected by that transient state. GitHub assignment mutations do not offer a transactional lock against simultaneous human edits; current issue state and assignment events are rechecked immediately before writes, and subsequent reconciliation respects manual changes.

Use Actions → Bounty claims → Run workflow on main for recovery. Leave `comment_id` empty to reconcile the repository, or supply an existing numeric comment ID. Keep `dry_run` enabled to inspect without writing. Manual assignments can still be made through ordinary GitHub permissions; they do not acquire an automatic expiry simply because the board displays them.

## Rollout and recovery

Publish the coordinator first, let its successful main run establish the activation timestamp, then move all five source workflow pins to the qualified action commit. During that transition an old source action may still show form guidance; the new action edits the same receipt when it starts. Do not replay unrelated contributor comments or fabricate claims for smoke tests. Use a user-authorized existing reservation for migration verification, and obtain authorization before creating a disposable live claim.

A failed state push aborts notification and Pages publication. Never force-push the ledger: rerun from fresh main so decisions are recomputed against the committed history. Source recovery must never acknowledge a reservation read only from an uncommitted candidate. The activation file and reservation history must move together on recovery; do not reset activation to process historical comments.

## Automatic awards

A configured maintainer’s merge is the points approval, including their own PR. Contributors claim the source issue, open the PR while the reservation is valid, and put `Closes #N` in its description. GitHub must record that PR as closing the bounty as completed. No independent award review, attestation, form or manually entered award is needed. Product CI and review protections remain authoritative.

The coordinator checks GitHub’s latest `ClosedEvent.closer`, the same-repository merged PR, the author’s numeric ID, and `merged_by` against `config.awardApprovers`. This existing configuration name now identifies maintainers whose merges approve points. Sam is configured by ID 16158892; login is a readable label and cannot transfer authority after a rename. Add other maintainers through reviewed configuration changes with verified IDs.

Claim eligibility is evaluated at PR creation. The author must have an accepted reservation then, or be the sole manually assigned contributor according to GitHub assignment events. Bot assignments alone cannot substitute for a valid reservation. Reservation expiry during review does not invalidate a PR submitted on time. Released, rejected, duplicate, later or expired-at-submission claims do not qualify. A manually closed issue, ordinary mention or arbitrary PR description cannot substitute for GitHub’s actual closing-PR evidence.

The workflow appends `policy: maintainer-merge` records to `data/awards.json` with the task, PR, numeric author and merger, points, reservation or assignment evidence, submission and merge times, final head and merge SHAs, and closure identity. It commits awards, claims and protocol activation atomically before notification or deployment. Retries discover the same evidence and cannot award twice. One task and one PR can each earn one award. Previously recorded independent-review awards remain verified under their original policy.

Every sync revalidates recorded awards. Display names are refreshed from the ID-verified PR author; the ledger’s original login remains unchanged. Do not change credited issue point labels or silently rewrite history. Corrections require a reviewed ledger change and an explicit reason. Missing or changed evidence fails deployment, preserving the last published site.

The [2026-10-01 missed-claim correction](CREDIT-RECOVERY-2026-10-01.md) records the owner-approved historical exception and its per-task qualification evidence.

## Deploy and recover

GitHub Pages must use Actions. `Community board` runs only from exact refs/heads/main. Pull-request checks have read-only permissions and never publish. The build allowlists site/ plus its generated board JSON; no review drafts, internal tooling, or credentials go into the artifact.

Use Actions → Community board → Run workflow to refresh immediately. A failed API request, rate limit, invalid label/award, or failed ledger push aborts deployment. The previous site remains available and shows its snapshot time; snapshots older than two hours display a stale warning. Do not interpret a failed sync as zero tasks or zero points.

Never force-push a reservation ledger after a concurrent main update. The push intentionally fails; rerun from the new main to recompute decisions. If a run persists a claim but fails before its comment, the next run posts the missing status receipt idempotently.

Keep the Actions token able to commit state/claims.json, state/claim-protocol.json and data/awards.json; a future ruleset must explicitly accommodate that narrow workflow or move state to a separately governed branch before enforcement. CODEOWNERS requests owner review but does not itself enforce a branch rule. Automatic awards follow the verified merge policy; manual corrections and configuration changes require maintainer review. The first setup does not alter organization-wide rulesets.

## PR CI notifications

The commit-pinned `actions/pr-ci` action reports qualification results in the five core source repositories. Each repository's separate `pr-ci-notifications.yml` controller runs on completion of its monitored workflows, with scheduled recovery every 15 minutes and an exact-main-only manual dry-run option. It uses only `actions: read`, `issues: write`, and `pull-requests: write` with the built-in token. It checks out no repository code, executes no PR input, downloads no artifacts, and holds no secrets, OIDC, approval, merge, publishing, or release authority.

First-time contributors still need maintainer approval to start CI. This controller never approves or reruns workflows. On a current-head failure it tags the PR author and links failed jobs and steps, asking them to fix the CI issues and push changes. Later failure details update the same trusted bot receipt. Older heads and superseded attempts cannot generate notifications. A successful rerun marks the failure receipt resolved.

Review readiness requires successful current-head PR-event runs from all applicable qualification workflows: Deep CI, Plane CI, Primitives CI qualification, Projection CI plus path-applicable Android/Apple lanes, and both LETS ci/security. Workflow paths come from the PR base commit; complete renamed/removed file inventories determine native applicability. Missing, pending, approval-required, skipped, neutral, or unsuccessful runs cannot qualify. Fork runs with an empty `pull_requests` list are matched using repository IDs, branch and head SHA.

Non-draft successful PRs request review from the ID-verified `armstrongsam25`. If a review is already pending, a new-head success receipt tags him instead. One success notification is sent per head SHA; repeated completion and recovery events stay silent. Sam's own PRs receive a success receipt without an impossible self-review request. This notification is an invitation to review, not approval to merge. Provider errors fail the controller while allowing other open PRs to reconcile; the next recovery run retries.

## Verification

`npm test` uses deterministic built-in Node tests, with a 90% line gate over all core API, synchronization, and claim/award model modules. Thin CLI/file wrappers and browser behavior are covered by build checks and live browser verification; this is not claimed as whole-site coverage. Product suites are separate from site checks. No remote mutations occur during unit tests.

To test real claim acceptance, first obtain approval to create a disposable bounty/claim pair. The initial launch deliberately publishes no synthetic tasks, claims, or leaderboard entries. Live API collection and Pages deployment can be verified before any issue is approved.
