# Changelog

## [0.2.1] - 2026-11-21

- Styled the OAuth callback page with a dark layout and embedded Devin logo.
- Added gallery preview image (`pi.image`) and `CHANGELOG.md` to the npm package.

## [0.2.0] - 2026-11-21

- Migrated imports and OAuth login flow from `@earendil-works/pi-ai/compat` to native `@earendil-works/pi-ai`.
- Added prompt caching breakpoints (`cacheControl`) on recent user and tool-result turns, plus `promptCache: { short: 300 }` on Claude models.
- Removed trailing synthetic `"Continue."` prompts after tool results and fixed parallel `toolCallId` matching.
- Parsed full model family metadata, real `maxOutputTokens`, reasoning flags, and thinking-toggle resolution from `GetCliModelConfigs`.
- Honored `model.baseUrl`, custom headers, `samplingParams`, and `allowNetwork: false` during offline catalog refresh.

## [0.1.1] - 2026-11-21

- Initial public release of the Devin subscription provider for Pi.
