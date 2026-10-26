import { dirname, relative, resolve, sep } from "node:path";
import js from "@eslint/js";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";

const sourceRoot = resolve(import.meta.dirname, "src");
const layerDependencies = {
  config: ["errors"],
  routes: ["controllers", "middlewares", "schemas", "models", "errors"],
  controllers: ["services", "schemas", "models", "errors"],
  middlewares: ["schemas", "models", "errors", "providers"],
  schemas: ["errors"],
  services: ["models", "errors", "repositories", "providers"],
  repositories: ["models", "errors"],
  providers: ["models", "errors"],
  models: ["errors"],
  errors: [],
  password: ["models", "errors"],
  "store/sqlite": ["models", "errors", "repositories"],
};
const providerInterfaces = ["PasswordProvider", "IdProvider", "LoggerProvider"];
const modelSecretFunctions = [
  "readPassword",
  "readHash",
  "createHash",
  "isCanonicalHash",
  "validateParams",
];
const transitionalSecretCallers = [
  "password/hasher.ts",
  "password/hasher.test.ts",
  "password/concurrency.test.ts",
  "password/password.bench.ts",
];

function sourcePath(filename) {
  return relative(sourceRoot, resolve(filename)).split(sep).join("/");
}

function moduleName(filename) {
  for (const module of [
    "repositories/sqlite",
    "providers/password",
    "store/sqlite",
  ]) {
    if (filename.startsWith(`${module}/`)) {
      return module;
    }
  }
  for (const module of [
    "providers/crypto-id-provider",
    "providers/json-logger-provider",
  ]) {
    if (filename === `${module}.ts` || filename === `${module}.test.ts`) {
      return module;
    }
  }
  const layer = filename.split("/")[0];
  if (filename.includes("/") && Object.hasOwn(layerDependencies, layer)) {
    return layer;
  }
  return undefined;
}

function layerName(module) {
  return module === "store/sqlite" ? module : module?.split("/")[0];
}

function importedName(specifier) {
  return (
    specifier.imported?.name ??
    specifier.imported?.value ??
    specifier.local?.name ??
    specifier.local?.value
  );
}

function namedAccess(node, names, typeOnly = false) {
  return (
    (node.specifiers?.length ?? 0) > 0 &&
    node.specifiers.every(
      (specifier) =>
        ["ImportSpecifier", "ExportSpecifier"].includes(specifier.type) &&
        names.includes(importedName(specifier)) &&
        (!typeOnly ||
          node.importKind === "type" ||
          node.exportKind === "type" ||
          specifier.importKind === "type" ||
          specifier.exportKind === "type"),
    )
  );
}

function implementationModule(module) {
  return [
    "repositories/sqlite",
    "providers/password",
    "providers/crypto-id-provider",
    "providers/json-logger-provider",
    "password",
    "store/sqlite",
  ].includes(module);
}

const projectPlugin = {
  rules: {
    dependencies: {
      meta: {
        type: "problem",
        schema: [],
        messages: {
          restricted:
            "Follow the dependency boundaries in docs/architecture.md.",
        },
      },
      create(context) {
        const filename = sourcePath(context.filename);
        const module = moduleName(filename);
        const layer = layerName(module);
        const testing = /\.(?:test|bench)\.ts$/.test(filename);
        const exportedClass =
          filename === "password/hasher.ts"
            ? "Hasher"
            : filename === "providers/password/argon2-password-provider.ts"
              ? "Argon2PasswordProvider"
              : undefined;
        const secretCaller =
          exportedClass !== undefined ||
          filename === "models/password/values.test.ts" ||
          transitionalSecretCallers.includes(filename);

        function check(node) {
          function reject() {
            context.report({ node, messageId: "restricted" });
          }

          if (
            secretCaller &&
            node.type.startsWith("Export") &&
            (node.type !== "ExportNamedDeclaration" ||
              exportedClass === undefined ||
              node.declaration?.type !== "ClassDeclaration" ||
              node.declaration.id?.name !== exportedClass)
          ) {
            reject();
            return;
          }
          if (
            (filename === "providers/index.ts" &&
              !namedAccess(node, providerInterfaces, true)) ||
            (filename === "repositories/index.ts" &&
              !namedAccess(node, ["UserRepository"], true))
          ) {
            reject();
            return;
          }

          const source = node.source?.value;
          if (typeof source !== "string") {
            return;
          }

          if (source.startsWith("node:")) {
            if (
              (["node:http", "node:https", "node:http2"].includes(source) &&
                filename !== "index.ts" &&
                !["routes", "controllers", "middlewares"].includes(layer)) ||
              (source === "node:sqlite" &&
                !["repositories/sqlite", "store/sqlite"].includes(module)) ||
              (source === "node:crypto" &&
                ![
                  "providers/password",
                  "providers/crypto-id-provider",
                  "providers/json-logger-provider",
                ].includes(module) &&
                ![
                  "password/hasher.ts",
                  "password/derive.ts",
                  "password/concurrency.test.ts",
                ].includes(filename))
            ) {
              reject();
            }
            return;
          }
          if (source === "vitest" || source.startsWith("vitest/")) {
            return;
          }
          if (!source.startsWith(".") || !source.endsWith(".ts")) {
            reject();
            return;
          }

          const target = sourcePath(resolve(dirname(context.filename), source));
          const targetModule = moduleName(target);
          const targetLayer = layerName(targetModule);
          if (
            target === "index.ts" ||
            targetModule === undefined ||
            (!testing && /\.(?:test|bench)\.ts$/.test(target))
          ) {
            reject();
            return;
          }

          if (target === "models/password/values.ts") {
            if (filename === "models/index.ts") {
              if (!namedAccess(node, ["Password", "EncodedHash"])) {
                reject();
              }
              return;
            }
            if (
              filename.startsWith("models/password/") &&
              filename !== "models/password/values.test.ts"
            ) {
              if (!namedAccess(node, ["Password", "EncodedHash"])) {
                reject();
              }
              return;
            }
            if (
              filename === "providers/password/argon2-password-provider.ts" ||
              filename === "models/password/values.test.ts" ||
              transitionalSecretCallers.includes(filename)
            ) {
              if (
                node.type !== "ImportDeclaration" ||
                !namedAccess(node, modelSecretFunctions)
              ) {
                reject();
                return;
              }
              return;
            }
            reject();
            return;
          }

          if (
            filename === "models/index.ts" &&
            target.startsWith("models/password/")
          ) {
            if (
              target !== "models/password/hash-parameters.ts" ||
              !namedAccess(node, ["Params", "Cost"], true)
            ) {
              reject();
            }
            return;
          }

          const serviceIntegration =
            [
              "services/auth-service.test.ts",
              "services/auth-service.integration.test.ts",
            ].includes(filename) && targetModule === "providers/password";
          if (
            implementationModule(targetModule) &&
            filename !== "index.ts" &&
            module !== targetModule &&
            !serviceIntegration
          ) {
            reject();
            return;
          }

          if (
            targetModule !== module &&
            target !== `${targetModule}/index.ts` &&
            ![
              "providers/crypto-id-provider.ts",
              "providers/json-logger-provider.ts",
            ].includes(target)
          ) {
            reject();
            return;
          }

          if (target === "providers/index.ts") {
            const allowed =
              layer === "middlewares" ? ["LoggerProvider"] : providerInterfaces;
            if (!namedAccess(node, allowed, true)) {
              reject();
              return;
            }
          }
          if (
            target === "repositories/index.ts" &&
            !namedAccess(node, ["UserRepository"], true)
          ) {
            reject();
            return;
          }
          if (
            filename !== "index.ts" &&
            targetModule !== module &&
            targetLayer !== layer &&
            !serviceIntegration &&
            !(layerDependencies[layer] ?? []).includes(targetLayer)
          ) {
            reject();
          }
        }

        return {
          ImportDeclaration: check,
          ExportNamedDeclaration: check,
          ExportAllDeclaration: check,
          ExportDefaultDeclaration: check,
        };
      },
    },
  },
};
const forbiddenAssertions = {
  selector: "TSAsExpression, TSTypeAssertion",
  message: "Do not use type assertions, including const assertions.",
};
const forbiddenDecorators = {
  selector: "Decorator",
  message: "Node type stripping does not support decorators.",
};
const forbiddenNamedImports = [
  {
    source: "node:crypto",
    names: ["argon2Sync"],
    message: "Use asynchronous crypto.argon2.",
  },
  {
    source: "node:crypto",
    names: [
      "getRandomValues",
      "randomFill",
      "randomFillSync",
      "randomInt",
      "webcrypto",
    ],
    message: "Use randomBytes or randomUUID from node:crypto.",
  },
  {
    source: "node:module",
    names: ["createRequire"],
    message: "Use static imports so module dependencies can be checked.",
  },
].map(({ source, names, message }) => {
  const pattern = `/^(?:${names.join("|")})$/`;
  return {
    selector: [
      `ImportDeclaration[source.value='${source}'] > ImportSpecifier[imported.name=${pattern}]`,
      `ExportNamedDeclaration[source.value='${source}'] > ExportSpecifier[local.name=${pattern}]`,
    ].join(", "),
    message,
  };
});
const forbiddenSyntax = [
  forbiddenAssertions,
  forbiddenDecorators,
  {
    selector:
      "ImportExpression, TSImportType, TSImportEqualsDeclaration, CallExpression[callee.name='require']",
    message: "Use static imports so module dependencies can be checked.",
  },
  ...forbiddenNamedImports,
];
const forbiddenProperties = [
  {
    object: "Math",
    property: "random",
    message: "Use node:crypto randomness.",
  },
  { property: "argon2Sync", message: "Use asynchronous crypto.argon2." },
  ...["getRandomValues", "randomFill", "randomFillSync", "randomInt"].map(
    (property) => ({
      property,
      message: "Use randomBytes or randomUUID from node:crypto.",
    }),
  ),
  {
    property: "webcrypto",
    message: "Use randomBytes or randomUUID from node:crypto.",
  },
  {
    property: "createRequire",
    message: "Use static imports so module dependencies can be checked.",
  },
];

const restrictedImports = [
  "error",
  {
    patterns: [
      {
        regex: "[^./][^/]*/\\.{1,2}(?:/|$)|//",
        message: "Use a direct relative path without redundant segments.",
      },
      {
        regex: "^(?:\\.\\.?/)+(?:[^/]+/)*src(?:/|$)",
        message:
          "Use a direct relative path within src without re-entering src.",
      },
      {
        regex: "^(?!node:|vitest(?:/|$))[^./]",
        message: "Runtime imports must use Node standard modules with node:.",
      },
    ],
  },
];

export default defineConfig(
  {
    ignores: [
      "node_modules/**",
      "coverage/**",
      "internal/**",
      ".agents/**",
      ".claude/**",
      ".codex/**",
      ".github/*",
      "!.github/scripts/",
      "src/httpapi/web/**",
    ],
  },
  {
    files: [
      "src/**/*.ts",
      ".github/scripts/**/*.ts",
      "vitest.config.ts",
      "eslint.config.js",
    ],
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
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "no-restricted-syntax": ["error", ...forbiddenSyntax],
      "no-restricted-properties": ["error", ...forbiddenProperties],
    },
  },
  {
    files: ["eslint.config.js"],
    extends: [tseslint.configs.disableTypeChecked],
  },
  {
    files: [".github/scripts/**/*.cjs"],
    extends: [js.configs.recommended],
    languageOptions: {
      sourceType: "commonjs",
      globals: {
        module: "writable",
        process: "readonly",
        require: "readonly",
      },
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/**/*.test.ts", "src/**/*.bench.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...forbiddenSyntax,
        {
          selector:
            "ImportDeclaration[source.value=/^vitest/], ExportNamedDeclaration[source.value=/^vitest/], ExportAllDeclaration[source.value=/^vitest/]",
          message: "Only tests and benchmarks may import Vitest.",
        },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    plugins: { project: projectPlugin },
    rules: {
      "no-restricted-imports": restrictedImports,
      "project/dependencies": "error",
    },
  },
);
