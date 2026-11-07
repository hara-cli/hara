# Core deferred-tool intent lexicon

This lexicon selects which existing tool schemas are available on the next provider request. It does not authorize an action, change tool approvals, or select the reply language. `core-capabilities.ts` still considers only the latest genuine user message and the current turn's governed browser opener.

The language dimension is in `src/locales/<tag>/core-intents.json`. English and Simplified Chinese preserve the existing patterns. Other future source locales must cover the same category keys. Traditional Chinese is generated from Simplified Chinese and checked in as `src/locales/zh-Hant/core-intents.generated.json`; the runtime consumes only the compiled `src/agent/core-intents.generated.ts`.

To change the lexicon:

1. Edit the locale sources. Keep regular-expression structure separate from the language text.
2. Install/use OpenCC 1.3.1 as a development tool, then run `OPENCC_BIN=/path/to/opencc npm run generate:core-intents`. Generation uses `s2twp.json` first, then `s2tw.json` and `s2t.json` for common Traditional variants. It records the version and dictionary/config hashes. It does not download tools or dictionaries.
3. Review the generated per-word conversion table and patterns. The generator combines word variants, so mixed forms such as `打開資料夾` work. Whole-regex alternatives would incorrectly bind each verb variant to only one noun variant.
4. Contextual dictionary mistakes belong in `core-intents.corrections.json`, with the exact expected OpenCC output and a reason. Currently UI `重载` means `重新載入`, not `過載`; an extended screen preview is `延伸螢幕預覽`, not a software extension. A changed converter output fails the correction check and requires review.
5. Run `OPENCC_BIN=/path/to/opencc npm run check:core-intents` to reproduce the checked-in output, then build and run the intent regressions.

The ordinary build verifies source/correction hashes, full category coverage, valid regexes, and consistency between the checked-in resource and runtime artifact. It needs no converter. Regeneration is a development/build-time operation; user messages are never converted at runtime, and the distributed CLI has no OpenCC dependency.

This is the separate intent-table slice. It does not migrate Desk messages, add the language registry/fallback/ICU system, or change Core closeout and watchdog language behavior; those remain in the later B0/B1/B2 work.
