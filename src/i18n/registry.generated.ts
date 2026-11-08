// Generated from registry.json; run scripts/generate-i18n.mjs --write.
export const LOCALE_REGISTRY = {
  "schemaVersion": 1,
  "languages": [
    {
      "tag": "en",
      "nativeName": "English",
      "match": "en-Latn",
      "fallback": [],
      "status": "stable",
      "font": "system-ui, sans-serif",
      "dir": "ltr"
    },
    {
      "tag": "zh-Hans",
      "nativeName": "简体中文",
      "match": "zh-Hans",
      "fallback": [
        "en"
      ],
      "status": "stable",
      "font": "\"PingFang SC\", \"Microsoft YaHei\", sans-serif",
      "dir": "ltr"
    },
    {
      "tag": "zh-Hant",
      "nativeName": "繁體中文",
      "match": "zh-Hant",
      "fallback": [
        "en"
      ],
      "status": "beta",
      "font": "\"PingFang TC\", \"Microsoft JhengHei\", sans-serif",
      "dir": "ltr"
    },
    {
      "tag": "zh-HK",
      "nativeName": "繁體中文（香港）",
      "match": "zh-Hant",
      "fallback": [
        "zh-Hant",
        "en"
      ],
      "status": "hidden",
      "font": "\"PingFang HK\", \"Microsoft JhengHei\", sans-serif",
      "dir": "ltr"
    },
    {
      "tag": "ja",
      "nativeName": "日本語",
      "match": "ja-Jpan",
      "fallback": [
        "en"
      ],
      "status": "hidden",
      "font": "\"Hiragino Sans\", \"Yu Gothic\", sans-serif",
      "dir": "ltr"
    },
    {
      "tag": "ko",
      "nativeName": "한국어",
      "match": "ko-Kore",
      "fallback": [
        "en"
      ],
      "status": "hidden",
      "font": "\"Apple SD Gothic Neo\", \"Malgun Gothic\", sans-serif",
      "dir": "ltr"
    }
  ]
} as const;
export type Locale = typeof LOCALE_REGISTRY.languages[number]["tag"];
export const LOCALE_REGISTRY_SHA256 = "7780d1a8e4c7b2959650b94985be6d4f84934f4044afde0abc9df59a4fd4bb90";
