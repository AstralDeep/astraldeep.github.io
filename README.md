# AstralDeep community

[Bounty board](https://astraldeep.github.io/bounties.html) · [Leaderboard](https://astraldeep.github.io/leaderboard.html) · [Contributor guide](https://astraldeep.github.io/contribute.html)

An independent GitHub Pages site coordinating point bounties across AstralDeep, AstralProjection, AstralPlane, AstralPrimitives, and LETS. Its priorities are protocol interoperability, reliable cross-client voice, LETS security, and reusable components. Points recognize accepted contributions; they are not money.

The ecosystem page includes a 2:22 slide introduction about bounded agent delegation and validated generative UI. Narration uses LLM Factory's `speaches-ai/Kokoro-82M-v1.0-ONNX` model and `af_heart` voice. The same-origin H.264/AAC video includes an English subtitle track, with default WebVTT closed captions and a separate text transcript for the web player. It describes the project's design and contributor goals. [Editable slides and story sources](docs/INTRODUCTION.md) support future updates.

Source issues own task scope. This repository owns exclusive seven-day reservations and a reviewed award ledger. Public API reads need no cross-repository write credential. The scheduled workflow uses its built-in token only to update this repository, acknowledge claims, and publish Pages. The optional pinned `actions/claim-reply` action gives source-issue `/claim` comments the correct form link or existing assignment status, using only the caller repository's issue permission. It does not create reservations or assignments. Product qualification and release controls remain separate.

## Development

Node.js 22 or newer; no npm dependencies.

```sh
npm test
npm run check
npm run build
python -m http.server 8765 --directory _site
```

`npm run sync` reads the five public GitHub repositories. Set `GITHUB_TOKEN` for an authenticated API rate limit when appropriate; never put it in browser code. A failed sync fails the deployment and preserves the previously published site. `npm run build:preview` permits an empty snapshot for offline CI checks. The deployment workflow uses `npm run build`, which requires a successful live sync in Actions.

## Maintenance

See [operations](docs/OPERATIONS.md) for labels, the award schema, refresh and recovery. Unapproved task drafts live outside this repository and never enter Pages artifacts. Do not seed the board with invented issues or achievements.

The layout and implementation are original; the contribution flow is inspired by [Kentucky Open Science](https://kentucky-open-science.github.io/bounties.html).
