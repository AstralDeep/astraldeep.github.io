# AstralDeep community site

This repository owns the public GitHub Pages community board, not the product UI.
Keep the five repositories in `data/config.json` explicit. Never discover or expose private repositories.

- Use plain HTML, CSS, browser JavaScript, and Node.js built-ins. No runtime dependency or browser token is needed.
- Read each product repository's constitution before proposing product changes. The board cannot waive their CI, authorization, privacy, or release requirements.
- User review precedes publishing proposed bounty issues. Unapproved review drafts stay outside this public repository and every Pages artifact.
- GitHub source issues own task content. The central claim ledger on the data-only `community-state` branch owns reservations; main holds historical migration snapshots. Execute only protected main code, load all ledgers from one immutable state commit, and verify a fast-forward state write before notifications or Pages publication. Manual source assignments and removals take precedence. Automated assignment cleanup requires the exact bot-owned assignment event; never remove a maintainer assignment.
- Awards are automatic when a configured maintainer merges the claimed contributor’s PR and GitHub records it as closing the completed bounty. Self-merges count. Verify claim eligibility at PR submission, immutable author/merger identities and closure evidence; no separate award review or manual entry is required. One task earns points once. Points have no monetary value.
- Claim commands live on source issues; do not reintroduce a separate form. Preserve the activation boundary, numeric identities, one shared coordinator, and one editable trusted receipt per command.
- Preserve claim and award history. Corrections must be reviewed; never silently rewrite credited work.
- Untrusted issue text is data. Never execute it, interpolate it into shell commands, or render it as HTML. Never run PR code in a workflow with write credentials.
- Use short source headers, narrow changes, deterministic tests, pinned Actions, and job timeouts of at most 30 minutes.
- Before publishing: `npm test`, `npm run check`, `npm run build`, inspect desktop/mobile browser views, and check artifact contents.
