# Public source distribution

The default installation uses a synthetic local seed, with no enrolled production account, model credentials, remote browser profile or customer project. A separate test-only fixture reproduces the larger historical control-plane data shape. Its accounts and documents are fictional. The hotel case in the GEO engine is also fictional.

## Included assets and checks

- Apache-2.0 code, subject to the individual upstream attributions in the root and embedded engine notices.
- The pinned upstream DeepSeek tokenizer under its accompanying MIT license.
- Twenty-nine original font files under SIL OFL 1.1, with the full license, per-font copyright notices and file hashes alongside them. The audit identifies the exact shipped bytes independently of installed system fonts.
- The pinned workbench screenshot comes from a local demo containing synthetic data.
- Ten source-generated LUTs. Run the following command to compare them to the current generator.

```sh
node engines/video-edit/bundles/ai-video/library/luts/generate-luts.mjs --check
```

Run `pnpm scan:public` on the installed tree. It checks source paths, common credential and personal-data indicators, configured private origins, binary allowlists, relative module references, and pinned font/tokenizer bytes. Installation directories are ignored on the working tree. For an exported tree with dependencies and run data excluded, use the strict mode.

```sh
node scripts/public-audit.mjs /path/to/export --distribution
```

Run `pnpm test:inherited` after installing locked dependencies and a working FFmpeg/FFprobe. The test profile uses a clean process environment and includes the public host, GEO, media and editing connector cases. Authorization is tested with disposable identities and fixture responses. These runs establish local behaviors only.

## Separately provisioned dependencies

The complete native video app, original profile and cover knowledge files, external platform accounts and desktop login state require the respective runtime and permissions. The standard local CLI and MCP still serve discovery, preflight and exact video intent plans. They list additional production capabilities only when the separate native catalog is present.

The draft native portrait library, private UI bootstrap and external prompt-fusion vendor cases from the original tree belong to that separate installation. The full catalog, native snapshot, original cover corpus/account profile and optional cover CLI cases run only when their actual dependencies are present. The other public checks continue to run. The original case data and output from private workspaces remain with their authorized owners.

Direct legacy GitHub Issue sending and the standalone GEO webhook sender are disabled. A GEO export to a local file stays a local receipt. External actions are handled through the BOT's scoped publication path, with a verified remote object required for public-delivery reporting.
