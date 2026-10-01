# AstralDeep community

[Bounty board](https://astraldeep.github.io/bounties.html) · [Leaderboard](https://astraldeep.github.io/leaderboard.html) · [Contributor guide](https://astraldeep.github.io/contribute.html)

An independent GitHub Pages site coordinating point bounties across AstralDeep, AstralProjection, AstralPlane, AstralPrimitives, and LETS. Its priorities are protocol interoperability, reliable cross-client voice, LETS security, and reusable components. Points recognize accepted contributions; they are not money.

Source issues own task scope. This repository owns exclusive seven-day reservations and a reviewed award ledger. Public API reads need no cross-repository write credential. The scheduled workflow uses its built-in token only to update this repository, acknowledge claims, and publish Pages. Product repository CI and release controls are unaffected.

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
