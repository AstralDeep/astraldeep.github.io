# AstralDeep community site

This repository owns the public GitHub Pages community board, not the product UI.
Keep the five repositories in `data/config.json` explicit. Never discover or expose private repositories.

- Use plain HTML, CSS, browser JavaScript, and Node.js built-ins. No runtime dependency or browser token is needed.
- Read each product repository's constitution before proposing product changes. The board cannot waive their CI, authorization, privacy, or release requirements.
- User review precedes publishing proposed bounty issues. Unapproved review drafts stay outside this public repository and every Pages artifact.
- GitHub source issues own task content. The central claim ledger owns reservations. Manual source assignments and removals take precedence. Automated assignment cleanup requires the exact bot-owned assignment event; never remove a maintainer assignment.
- Award records require a merged PR, a closed completed bounty, the PR author's identity, and an independent maintainer approval review. One task earns points once. Points have no monetary value.
- Claim commands live on source issues; do not reintroduce a separate form. Preserve the activation boundary, numeric identities, one shared coordinator, and one editable trusted receipt per command.
- Preserve claim and award history. Corrections must be reviewed; never silently rewrite credited work.
- Untrusted issue text is data. Never execute it, interpolate it into shell commands, or render it as HTML. Never run PR code in a workflow with write credentials.
- Use short source headers, narrow changes, deterministic tests, pinned Actions, and job timeouts of at most 30 minutes.
- Before publishing: `npm test`, `npm run check`, `npm run build`, inspect desktop/mobile browser views, and check artifact contents.
