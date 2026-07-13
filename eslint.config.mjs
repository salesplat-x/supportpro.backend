import js from "@eslint/js";
import tseslint from "typescript-eslint";
import eslintConfigPrettier from "eslint-config-prettier";
import importX from "eslint-plugin-import-x";

export default tseslint.config(
  {
    ignores: ["dist/**", "build/**", "node_modules/**", "swagger.yaml", "swagger-custome.js"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  eslintConfigPrettier,
  {
    plugins: { "import-x": importX },
    settings: {
      "import-x/resolver": {
        typescript: { project: "./tsconfig.json" },
      },
    },
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
      // Catches "Import can be shortened" cases — e.g. "./foo/index.js" instead
      // of "./foo.js", or redundant "../" segments.
      "import-x/no-useless-path-segments": ["warn", { noUselessIndex: true }],
    },
  },
  {
    // Type-aware linting, scoped to files actually covered by a tsconfig —
    // lets us catch real bugs invisible to syntax-only rules (floating
    // promises, promises misused as sync callbacks, etc). Applying this
    // block globally breaks parsing for plain-JS config files that aren't
    // part of either tsconfig.
    files: ["src/**/*.ts", "tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.json", "./tsconfig.jest.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/await-thenable": "error",
    },
  },
  {
    // supertest's res.body is typed `any`, so unguarded res.body.data.x.y chains
    // are invisible to type checking — these rules catch that. Scoped to tests/
    // only: src/ intentionally keeps no-explicit-any off, and enabling the
    // no-unsafe-* family there is a separate, larger decision.
    files: ["tests/**/*.ts"],
    languageOptions: {
      parserOptions: {
        project: "./tsconfig.jest.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unsafe-member-access": "warn",
      "@typescript-eslint/no-unsafe-assignment": "warn",
      "@typescript-eslint/no-unsafe-call": "warn",
      "@typescript-eslint/no-unsafe-argument": "warn",
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
