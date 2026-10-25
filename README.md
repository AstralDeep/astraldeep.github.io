# AstralDeep community

[Downloads](https://astraldeep.github.io/downloads.html) · [Bounty board](https://astraldeep.github.io/bounties.html) · [Leaderboard](https://astraldeep.github.io/leaderboard.html) · [Contributor guide](https://astraldeep.github.io/contribute.html)

An independent GitHub Pages site coordinating point bounties across AstralDeep, AstralProjection, AstralPlane, AstralPrimitives, and LETS. Its priorities are protocol interoperability, reliable cross-client voice, LETS security, and reusable components. Points recognize accepted contributions; they are not money.

The ecosystem page includes a 2:17 slide introduction about bounded agent delegation and validated generative UI. Narration uses LLM Factory's `speaches-ai/Kokoro-82M-v1.0-ONNX` model and `af_heart` voice. The same-origin H.264/AAC video includes an English subtitle track, with default WebVTT closed captions and a separate text transcript for the web player. It describes the project's design and contributor goals. [Editable slides and story sources](docs/INTRODUCTION.md) support future updates.

Source issues own task scope and published points. Choose an approved bounty, open a tested PR with `Closes #N` in its description, and earn the published points when it successfully merges into `main` and GitHub records the completed issue closure. The bot credits the PR author automatically, including self-merges. No reservation or assignment is required.

The community workflow reads the five public sources, verifies merge and closure evidence, persists the award ledger on the data-only `community-state` branch, and publishes Pages. Product qualification and release controls remain in force. The board refreshes automatically while visible.

## Development

Node.js 22 or newer; no npm dependencies.

```sh
npm test
npm run check
npm run build
python -m http.server 8765 --directory _site
```

`npm run sync` reads the five public GitHub repositories and the live `community-state` ledgers without updating them. The main ledger copies are historical snapshots. Set `GITHUB_TOKEN` for an authenticated API rate limit when appropriate; never put it in browser code. A failed sync preserves the previously published board. `npm run build:preview` permits an empty snapshot for offline CI checks.

Static page changes use the separate `Publish site pages` workflow. It retains the published board only when every award matches the immutable live ledger, its original timestamp matches the successful main Community board run, and its task data and derived totals validate. It writes no ledger state and keeps the original timestamp/stale warning. Both publishers share one concurrency group. This permits a Downloads/layout update while unavailable provider history still correctly blocks fresh award reconciliation. `npm run build` requires a verified snapshot in Actions.

## Maintenance

The Downloads page reads `data/downloads.json`; `macos: null` exposes no installer link. Adding a release requires a product-authorized notarized Mac archive, an immutable public GitHub release, exact source pins, provider-supplied asset digests and matching checksum bytes. The build checks public availability against GitHub; it does not grant release authority or establish notarization. Offline previews omit installer links. See [download operations](docs/DOWNLOADS.md).

See [operations](docs/OPERATIONS.md) for labels, the award schema, refresh and recovery. Unapproved task drafts live outside this repository and never enter Pages artifacts. Do not seed the board with invented issues or achievements.

The layout and implementation are original; the contribution flow is inspired by [Kentucky Open Science](https://kentucky-open-science.github.io/bounties.html).
