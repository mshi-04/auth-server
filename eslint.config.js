import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const projectModules = [
  "auth",
  "password",
  "httpapi",
  "store/sqlite",
  "config",
  "log",
];
const forbiddenAssertions = {
  selector: "TSAsExpression, TSTypeAssertion",
  message: "Do not use type assertions, including const assertions.",
};

function restrictedImports(
  allowedModules,
  allowHttp = false,
  allowSqlite = false,
) {
  const paths = [
    {
      name: "node:crypto",
      importNames: ["argon2Sync"],
      message: "Use asynchronous crypto.argon2.",
    },
  ];

  if (!allowHttp) {
    paths.push({
      name: "node:http",
      message: "Only httpapi and main.ts may depend on node:http.",
    });
  }
  if (!allowSqlite) {
    paths.push({
      name: "node:sqlite",
      message: "Only store/sqlite may depend on node:sqlite.",
    });
  }

  const patterns = [
    {
      regex: "[^./][^/]*/\\.{1,2}(?:/|$)|//",
      message: "Use a direct relative path without redundant segments.",
    },
    {
      regex: `^(?:\\.\\.?/)+(?:${projectModules.join("|")})/(?!index\\.ts$)`,
      message: "Import another module through its index.ts.",
    },
    {
      regex: "^(?!node:|vitest(?:/|$))[^./]",
      message: "Runtime imports must use Node standard modules with node:.",
    },
  ];

  const forbiddenModules = projectModules.filter(
    (module) => !allowedModules.includes(module),
  );
  if (forbiddenModules.length > 0) {
    patterns.push({
      regex: `^(?:\\.\\.?/)+(?:${forbiddenModules.join("|")})(?:/|$)`,
      message: "Follow the dependency direction in docs/architecture.md.",
    });
  }
  if (!allowedModules.includes("errors")) {
    patterns.push({
      regex: "^(?:\\.\\.?/)+errors\\.ts$",
      message: "This module must not depend on errors.ts.",
    });
  }
  patterns.push({
    regex: "^(?:\\.\\.?/)+main\\.ts$",
    message: "Only the entry point assembles the application.",
  });

  return ["error", { paths, patterns }];
}

export default defineConfig(
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "internal/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".github/**",
      "src/httpapi/web/**",
    ],
  },
  {
    files: ["src/**/*.ts", "vitest.config.ts", "eslint.config.js"],
    extends: [js.configs.recommended, tseslint.configs.strictTypeChecked],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-restricted-syntax": ["error", forbiddenAssertions],
      "no-restricted-properties": [
        "error",
        {
          object: "Math",
          property: "random",
          message: "Use node:crypto randomness.",
        },
        { property: "argon2Sync", message: "Use asynchronous crypto.argon2." },
      ],
    },
  },
  {
    files: ["eslint.config.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts", "src/**/*.bench.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        forbiddenAssertions,
        {
          selector: "ImportExpression",
          message: "Use static imports so module dependencies can be checked.",
        },
        {
          selector:
            "ImportDeclaration[source.value=/^vitest/], ExportNamedDeclaration[source.value=/^vitest/], ExportAllDeclaration[source.value=/^vitest/]",
          message: "Only tests and benchmarks may import Vitest.",
        },
      ],
    },
  },
  {
    files: ["src/main.ts"],
    rules: {
      "no-restricted-imports": restrictedImports(
        [...projectModules, "errors"],
        true,
      ),
    },
  },
  {
    files: ["src/errors.ts", "src/errors.test.ts"],
    rules: { "no-restricted-imports": restrictedImports(["errors"]) },
  },
  {
    files: ["src/config/**/*.ts", "src/log/**/*.ts"],
    rules: { "no-restricted-imports": restrictedImports([]) },
  },
  {
    files: ["src/password/**/*.ts"],
    rules: { "no-restricted-imports": restrictedImports(["errors"]) },
  },
  {
    files: ["src/auth/**/*.ts"],
    rules: {
      "no-restricted-imports": restrictedImports(["password", "log", "errors"]),
    },
  },
  {
    files: ["src/httpapi/**/*.ts"],
    rules: {
      "no-restricted-imports": restrictedImports(
        ["auth", "log", "errors"],
        true,
      ),
    },
  },
  {
    files: ["src/store/sqlite/**/*.ts"],
    rules: {
      "no-restricted-imports": restrictedImports(
        ["auth", "errors"],
        false,
        true,
      ),
    },
  },
);
