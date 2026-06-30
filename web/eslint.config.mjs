import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import reactPlugin from "eslint-plugin-react";
import reactHooksPlugin from "eslint-plugin-react-hooks";
import jsxA11y from "eslint-plugin-jsx-a11y";

export default [
  { ignores: ["dist/**", "node_modules/**", "public/staticwebapp.config.json"] },
  {
    files: ["src/**/*.{ts,tsx}", "tests/**/*.{ts,tsx}"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
      globals: {
        window: "readonly",
        document: "readonly",
        fetch: "readonly",
        console: "readonly",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      react: reactPlugin,
      "react-hooks": reactHooksPlugin,
      "jsx-a11y": jsxA11y,
    },
    settings: { react: { version: "detect" } },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      ...reactPlugin.configs.recommended.rules,
      ...reactHooksPlugin.configs.recommended.rules,
      ...jsxA11y.configs.recommended.rules,
      "react/react-in-jsx-scope": "off",
      "react/prop-types": "off",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
    },
  },
  // ADR-0012 §5 / ADR-0016 §6 — Microsoft-authored prose must render
  // plain-text only. `react/no-danger` is a hard error inside the feature
  // folders that handle upstream prose. Subsequent verticals add entries for
  // their own feature folders.
  {
    files: [
      "src/features/secureScore/**/*.{ts,tsx}",
      "src/features/incidents/**/*.{ts,tsx}",
      // §10.60 INFO-2 — Defender for Cloud Secure Score (ADR-0036). Same
      // ARM-control-name + recommendation-prose surface as Microsoft
      // Secure Score; same no-danger discipline.
      "src/features/azure-secure-score/**/*.{ts,tsx}",
      // ADR-0037 — ransomware.live PRO threat-intel. Adversarial-input
      // class data: the `activity` field is threat-actor-authored (leak-
      // site post), the `summary` field is HudsonRock-enriched third-party
      // prose. Same hard no-`dangerouslySetInnerHTML` discipline as the
      // Microsoft-authored surfaces above. Covers both the feature folder
      // and the drilldown page file so a future refactor that moves
      // components around doesn't silently drop the gate.
      "src/features/ransomware/**/*.{ts,tsx}",
      "src/pages/RansomwarePage.{ts,tsx}",
    ],
    rules: {
      "react/no-danger": "error",
    },
  },
];
