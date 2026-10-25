# Client downloads

`downloads.html` is the first main navigation entry and the home page's primary action. It uses the shared appearance and renders static release links without a browser token or runtime API dependency.

## Current state

`data/downloads.json` contains `macos: null`. The page shows that the Mac download is in preparation and offers no installer link. A private build or an App Store `.pkg` is not a direct-download release.

The Mac package under preparation is AstralDeep 1.8 (69), Apple silicon, macOS 14 or later. It uses the registered bundle identity and the DirectDownload distribution. Public availability remains subject to the product repository's protected release process. A notarized local export alone does not authorize publication.

## Publish a qualified release

1. Use AstralDeep's protected release process to qualify, sign, notarize, staple and publish the Mac archive. A ZIP must contain the stapled app; a DMG also needs its outer-container notarization. Verify the downloaded final bytes with Gatekeeper and retain the Apple result and protected release receipt in the product's release evidence. App Store submission is a separate action.
2. Publish a create-only `macos-v<version>-<build>` GitHub release in `AstralDeep/AstralDeep`, with release immutability enabled. This namespace does not activate the existing `apple-v*` Store workflow or Windows `v*` workflow.
3. Include `AstralDeep-<version>-<build>-<architecture>.<format>` (`dmg` or `zip`) and a `SHA256SUMS` file containing exactly the archive's SHA-256, two spaces, its filename, and a newline. Hash the final stapled bytes.
4. Update `data/downloads.json` through a reviewed site PR using the protected release's metadata, not values inferred from an installed app. Do not copy a candidate manifest into this file.

The non-null `macos` object has `version` (string), `build` (positive integer), `minimumMacOS` (string), `architecture` (`arm64`, `x86_64` or `universal`), `format` (`dmg` or `zip`), `channel` (`stable` or `preview`), `bytes` (positive integer), `sha256` (lowercase hex), `url`, `releaseURL`, `checksumsURL`, and `source` with exact `deep` and `projection` commit hashes. Shape validation is not publication or notarization evidence. Notarization status strings and submission UUIDs are intentionally not accepted as website proof.

The production build independently requires a non-draft immutable published release whose prerelease flag matches its declared channel, its exact tag and source commit, the committed Projection gitlink, unique uploaded asset identities, a GitHub-provided archive digest and matching size, and bounded checksum-file bytes matching both their provider digest and the archive entry. Missing evidence, API failure or disagreement fails the build and preserves the previous Pages deployment. The workflow supplies only its built-in job token to the build process; no credential enters HTML or JSON.

`npm run build:preview` is offline and omits installer links even when a release is configured. Unit tests inject provider fixtures to exercise available and denied paths without making CI depend on live GitHub services.

## Verification

Run `npm test`, `npm run check` and `npm run build`. Inspect desktop and 320 px mobile views in both appearances, keyboard navigation, the download link, release notes, checksum details, and `_site/data/downloads.json`. The public artifact must contain no candidate archive, signing material, private review file or internal ledger. Product signing and release gates remain in AstralDeep.
