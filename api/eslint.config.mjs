import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";

export default [
  {
    ignores: ["dist/**", "node_modules/**"],
  },
  {
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 2023,
        sourceType: "module",
      },
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": "warn",
    },
  },
  // L12-FT-04 — backstop the `@internal` export contract on
  // `buildShareUrlOrAievent`. The function is exported solely so the
  // unit tests in `reportShareUrlRequired.test.ts` can exercise the
  // SEC-L-L12-02 hard-fail flag without driving the full
  // `sendReportSnapshotEmail` orchestrator. JS has no enforced
  // visibility, so a future contributor could accidentally import
  // it from a src/ module and bypass the orchestrator's pre/post
  // invariants. This rule fails closed: only files under `tests/`
  // may import the symbol; everywhere else fails the lint gate.
  {
    files: ["src/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          // L12-FT-04 WS10 advisory — defensive third path entry for the
          // currently-non-existent `src/<one>/<two>/<file>.ts` depth.
          // Today src/ is exactly two levels (`functions`, `ingest`, `lib`),
          // so the first two entries are exhaustive. Adding the third
          // up-front means a future nested folder doesn't silently slip
          // a new import past the gate.
          paths: [
            {
              name: "./reportEmail.js",
              importNames: ["buildShareUrlOrAievent"],
              message:
                "buildShareUrlOrAievent is @internal (L12-FT-04). Call sites should go through sendReportSnapshotEmail. If you genuinely need to drive the share-URL minting from new code, factor the call into a new orchestrator API surface and add the function to its public exports.",
            },
            {
              name: "../lib/reportEmail.js",
              importNames: ["buildShareUrlOrAievent"],
              message:
                "buildShareUrlOrAievent is @internal (L12-FT-04). Call sites should go through sendReportSnapshotEmail. If you genuinely need to drive the share-URL minting from new code, factor the call into a new orchestrator API surface and add the function to its public exports.",
            },
            {
              name: "../../lib/reportEmail.js",
              importNames: ["buildShareUrlOrAievent"],
              message:
                "buildShareUrlOrAievent is @internal (L12-FT-04). Call sites should go through sendReportSnapshotEmail. If you genuinely need to drive the share-URL minting from new code, factor the call into a new orchestrator API surface and add the function to its public exports.",
            },
          ],
        },
      ],
    },
  },
];
