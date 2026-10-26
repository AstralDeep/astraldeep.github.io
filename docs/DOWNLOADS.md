# Client downloads

`downloads.html` is the first main navigation entry and the home page's primary action. It uses the shared appearance and renders static release links without a browser token or runtime API dependency.

## Current state

The committed floor, `data/downloads.json`, points to the immutable Mac 1.8 (69) preview, Apple silicon, macOS 14 or later. The site renders it until a newer release is published. The public ZIP contains the Developer ID-signed, Apple-notarized, stapled app; its exact bytes and provider digests were checked after anonymous download. Open the ZIP and move AstralDeep to Applications.

This first preview uses an explicit owner-approved, artifact-bound manual publication exception while the protected Mac publisher is being configured. Approval covers ZIP SHA-256 `9eecfa0e88e3425563494849aee48fb195e14bdb7fe9bea4493a722642cd79d9` and enabling immutable releases in `AstralDeep/AstralDeep` only. The release's `release-provenance.json` states its verified scope and limits. It does not claim canonical protected-publisher approval or complete computer-harness qualification, and it does not authorize another release. Later releases follow the automated flow below.

## Publish a qualified release

Releases are automatic. After CI passes on AstralDeep `main`, its release workflow builds, signs, notarizes and staples a DMG, then publishes an immutable stable `macos-v<version>-<build>` release in `AstralDeep/AstralDeep` that is never marked Latest. The owner can publish the same way from their Mac with `scripts/release_macos.py --publish`. Each release carries `AstralDeep-<version>-<build>-arm64.dmg`, `SHA256SUMS`, `release-provenance.json`, its notes `.md`, and four site files: `downloads.json`, `appcast.xml`, `mac-update-policy.json` and `mac-update-policy.json.sig`. This site never signs, notarizes or publishes packages and holds no cross-repository credential.

1. Every build except `--preview` lists the releases and takes the highest non-draft `macos-v` build. It ignores other tag namespaces and refuses two releases with the same newest build.
2. It downloads the four site files from their release asset URLs without credentials, within fixed limits: `downloads.json` 16 KiB, `appcast.xml` 2 MiB, the policy 4 KiB and its signature 256 bytes. Each must be the release's single uploaded asset of that name, and its bytes must match the size and digest GitHub reports.
3. The `downloads.json` record must name that exact tag. The build then runs the published-download checks below, requires the appcast's newest item to match the record, verifies the policy's Ed25519 signature with the Sparkle public key in `scripts/appcast.mjs`, and requires the policy's minimum build to be no higher than the release's build.
4. It publishes the record at `data/downloads.json`, the feed at `appcast.xml`, and the policy at `data/mac-update-policy.json` and `data/mac-update-policy.json.sig`. Any failure fails the build and keeps the previous Pages deployment.
5. `Release sync` runs every ten minutes and on dispatch. It compares the newest release tag with the live `data/downloads.json` and redeploys Pages only when they differ. The Community board and Publish site pages workflows run the same discovery whenever they build.

### The floor record

The committed `data/downloads.json` is a floor. A newest release with a lower build fails the build. A release with the same build, or no newer release, renders the floor after the same published-download checks, without an appcast or policy. Raise the floor only through a reviewed site PR, to a release that is already published, by copying that release's `downloads.json` asset. Keep `macos: null` only while no release exists. Never copy a candidate manifest into this file.

The non-null `macos` object has `version` (string), `build` (positive integer), `minimumMacOS` (string), `architecture` (`arm64`, `x86_64` or `universal`), `format` (`dmg` or `zip`), `channel` (`stable` or `preview`), `bytes` (positive integer), `sha256` (lowercase hex), `url`, `releaseURL`, `checksumsURL`, and `source` with exact `deep` and `projection` commit hashes. Shape validation is not publication or notarization evidence. Notarization status strings and submission UUIDs are intentionally not accepted as website proof.

For the record it renders, the production build independently requires a non-draft immutable published release whose prerelease flag matches its declared channel, its exact tag and source commit, the committed Projection gitlink, unique uploaded asset identities, a GitHub-provided archive digest and matching size, and bounded checksum-file bytes matching both their provider digest and the archive entry. Missing evidence, API failure or disagreement fails the build and preserves the previous Pages deployment. The workflow supplies only its built-in job token to the build process; no credential enters HTML or JSON.

`npm run build:preview` is offline and omits installer links and feed files even when a release is configured. Unit tests inject provider and asset fixtures, signed with a test key, to exercise available and denied paths without making CI depend on live GitHub services.

## Verification

Run `npm test`, `npm run check` and `npm run build`. Inspect desktop and 320 px mobile views in both appearances, keyboard navigation, the download link, release notes, checksum details, `_site/data/downloads.json`, and, for a discovered release, `_site/appcast.xml` and the policy files. The public artifact must contain no candidate archive, signing material, private review file or internal ledger. Product signing and release gates remain in AstralDeep.
