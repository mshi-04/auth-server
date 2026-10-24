import { Linter } from "eslint";
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import { beforeAll, describe, expect, it } from "vitest";
import eslintConfig from "../../eslint.config.js";

const lintConfig = defineConfig(eslintConfig, {
  files: ["src/**/*.ts"],
  extends: [tseslint.configs.disableTypeChecked],
});
const linter = new Linter();

beforeAll(() => {
  linter.verify("export {};", lintConfig, { filename: "src/errors.test.ts" });
}, 30_000);
const declarationForms: [string, (source: string) => string][] = [
  ["import", (source: string) => `import "${source}";`],
  ["named export", (source: string) => `export { value } from "${source}";`],
  ["export all", (source: string) => `export * from "${source}";`],
];

const forbiddenImports = [
  ["src/config/settings.ts", "../../src/auth/index.ts"],
  ["src/config/settings.ts", "../../src/auth/service.ts"],
  ["src/config/settings.ts", "../../../auth-server/src/auth/index.ts"],
  ["src/config/settings.ts", "../../../auth-server/src/auth/service.ts"],
  ["src/config/settings.ts", "../../src/errors.ts"],
  ["src/config/settings.ts", "../../src/main.ts"],
  ["src/config/nested/settings.ts", "../../../src/auth/index.ts"],
  ["src/auth/service.ts", "../../src/password/hash.ts"],
  ["src/httpapi/handler.ts", "../../src/password/index.ts"],
  ["src/store/sqlite/store.ts", "../../../src/auth/service.ts"],
  ["src/main.ts", "../src/auth/service.ts"],
  ["src/errors.ts", "../src/auth/index.ts"],
  ["src/config/settings.ts", "../auth/index.ts"],
  ["src/auth/service.ts", "../password/hash.ts"],
];
const allowedImports = [
  ["src/config/settings.ts", "./errors.ts"],
  ["src/config/nested/settings.ts", "../errors.ts"],
  ["src/config/nested/settings.ts", "./helper.ts"],
  ["src/auth/service.ts", "../password/index.ts"],
  ["src/auth/nested/service.ts", "../../password/index.ts"],
  ["src/store/sqlite/store.ts", "../../auth/index.ts"],
  ["src/password/hash.ts", "../errors.ts"],
  ["src/httpapi/handler.ts", "../auth/index.ts"],
  ["src/main.ts", "./store/sqlite/index.ts"],
  ["src/errors.test.ts", "./errors.ts"],
];

describe.each(declarationForms)(
  "module import policy: %s",
  (_, declaration) => {
    it.each(forbiddenImports)("rejects %s -> %s", (filename, source) => {
      const messages = linter.verify(declaration(source), lintConfig, {
        filename,
      });

      expect(messages.filter((message) => message.fatal)).toEqual([]);
      expect(messages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ ruleId: "no-restricted-imports" }),
        ]),
      );
    });

    it.each(allowedImports)("allows %s -> %s", (filename, source) => {
      expect(
        linter.verify(declaration(source), lintConfig, { filename }),
      ).toEqual([]);
    });

    it.each([
      ["src/config/settings.ts", "../errors.ts"],
      ["src/config/nested/settings.ts", "../../errors.ts"],
      ["src/log/logger.ts", "../errors.ts"],
      ["src/log/nested/logger.ts", "../../errors.ts"],
    ])("rejects root errors: %s -> %s", (filename, source) => {
      expect(
        linter.verify(declaration(source), lintConfig, { filename }),
      ).toEqual([
        expect.objectContaining({ ruleId: "project/no-root-errors" }),
      ]);
    });
  },
);

describe("forbidden syntax", () => {
  it.each(["src/auth/service.ts", "src/auth/service.test.ts"])(
    "rejects decorators in %s",
    (filename) => {
      const source = [
        "export function sealed(value: unknown): unknown {",
        "  return value;",
        "}",
        "@sealed",
        "export class Service {",
        "  run(): number {",
        "    return 1;",
        "  }",
        "}",
      ].join("\n");

      const messages = linter.verify(source, lintConfig, { filename });

      expect(messages.filter((message) => message.fatal)).toEqual([]);
      expect(messages).toEqual([
        expect.objectContaining({
          ruleId: "no-restricted-syntax",
          message: "Node type stripping does not support decorators.",
        }),
      ]);
    },
  );
});
