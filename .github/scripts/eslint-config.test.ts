import { Linter } from "eslint";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import { expect, it } from "vitest";
import eslintConfig from "../../eslint.config.js";

const lintConfig = defineConfig(eslintConfig, {
  files: ["src/**/*.ts", "tests/support/**/*.ts"],
  extends: [tseslint.configs.disableTypeChecked],
});
const linter = new Linter();
const policyRules = [
  "project/dependencies",
  "no-restricted-imports",
  "no-restricted-syntax",
];
const service = "src/services/auth-service.ts";
const passwordProvider = "src/providers/password/argon2-password-provider.ts";
const secretImport =
  'import { readPassword } from "../../models/password/values.ts"; export class Argon2PasswordProvider {}';
const testingHook =
  'import { replaceDerivationForTesting } from "./derive.ts"; void replaceDerivationForTesting;';
const supportImport =
  'import { rejected } from "../../tests/support/errors.ts"; void rejected;';

type SmokeCase = [
  name: string,
  ruleId: string,
  allowedFile: string,
  allowedCode: string,
  deniedFile: string,
  deniedCode: string,
];

const cases: SmokeCase[] = [
  [
    "service interfaces",
    "project/dependencies",
    service,
    'import type { UserRepository } from "../repositories/index.ts";',
    service,
    'import type { SqliteUserRepository } from "../repositories/sqlite/index.ts";',
  ],
  [
    "SQLite ownership",
    "project/dependencies",
    "src/repositories/sqlite/initialization.ts",
    'import "node:sqlite";',
    service,
    'import "node:sqlite";',
  ],
  [
    "canonical Node imports",
    "no-restricted-imports",
    "src/config/env.ts",
    'import "node:fs";',
    "src/config/env.ts",
    'import "fs";',
  ],
  [
    "static imports",
    "no-restricted-syntax",
    service,
    'import "../models/index.ts";',
    service,
    'import("../models/index.ts");',
  ],
  [
    "model secrets",
    "project/dependencies",
    passwordProvider,
    secretImport,
    "src/providers/password/derive.ts",
    secretImport,
  ],
  [
    "testing hooks",
    "no-restricted-syntax",
    "src/providers/password/concurrency.test.ts",
    testingHook,
    passwordProvider,
    testingHook,
  ],
  [
    "test support boundary",
    "project/dependencies",
    "src/services/auth-service.test.ts",
    supportImport,
    service,
    supportImport,
  ],
  [
    "test support dependencies",
    "project/dependencies",
    "tests/support/fakes/logger.ts",
    'import type { LoggerProvider } from "../../../src/providers/index.ts";',
    "tests/support/fakes/logger.ts",
    'import { JsonLoggerProvider } from "../../../src/providers/json-logger-provider.ts";',
  ],
];

function rules(filename: string, code: string) {
  const messages = linter.verify(code, lintConfig, { filename });
  expect(messages.filter((message) => message.fatal)).toEqual([]);
  return messages.map((message) => message.ruleId);
}

it.each(cases)(
  "%s permits legitimate use and rejects violations",
  (_name, ruleId, allowedFile, allowedCode, deniedFile, deniedCode) => {
    expect(
      rules(allowedFile, allowedCode).filter((rule) =>
        policyRules.includes(rule ?? ""),
      ),
    ).toEqual([]);
    expect(rules(deniedFile, deniedCode)).toContain(ruleId);
  },
  30_000,
);
