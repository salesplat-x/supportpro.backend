import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";

export default tseslint.config(
  {
    ignores: ["dist/**", "build/**", "node_modules/**", "swagger.yaml", "swagger-custome.js"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/no-explicit-any": "off",
      // "all": only require const if every variable in a destructure is unchanged
      "prefer-const": ["error", { destructuring: "all" }],
      // Pre-existing patterns in the codebase - downgraded to warnings so CI
      // can be enabled without a large refactor; tighten over time.
      "no-useless-assignment": "warn",
      "@typescript-eslint/no-non-null-asserted-optional-chain": "warn",
      "@typescript-eslint/no-unsafe-function-type": "warn",
    },
  },
  {
    files: ["*.config.js", "*.config.mjs"],
    languageOptions: {
      globals: { module: "writable", require: "readonly", process: "readonly" },
    },
  },
  {
    files: ["generate-swagger.ts"],
    rules: {
      "@typescript-eslint/no-require-imports": "warn",
      "preserve-caught-error": "warn",
      "no-case-declarations": "warn",
    },
  }
);
