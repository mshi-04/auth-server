import { dirname, relative, sep } from "node:path";
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
const policyRules = [
  "project/dependencies",
  "no-restricted-imports",
  "no-restricted-syntax",
];

function messages(filename: string, code: string) {
  const result = linter.verify(code, lintConfig, { filename });
  expect(result.filter((message) => message.fatal)).toEqual([]);
  return result;
}

function allows(filename: string, code: string): void {
  expect(
    messages(filename, code).filter((message) =>
      policyRules.includes(message.ruleId ?? ""),
    ),
  ).toEqual([]);
}

function rejects(
  filename: string,
  code: string,
  ruleId = "project/dependencies",
): void {
  expect(messages(filename, code).map((message) => message.ruleId)).toContain(
    ruleId,
  );
}

function sourcePath(filename: string, target: string): string {
  const source = relative(dirname(filename), target).split(sep).join("/");
  return source.startsWith(".") ? source : "./" + source;
}

function namedImport(source: string, name: string, typeOnly = false): string {
  return (
    "import " +
    (typeOnly ? "type " : "") +
    "{ " +
    name +
    " as Dependency } from " +
    JSON.stringify(source) +
    "; " +
    (typeOnly ? "export type { Dependency };" : "void Dependency;")
  );
}

beforeAll(() => {
  messages("src/config/env.ts", "export {};");
}, 30_000);

const declarationForms: [string, (source: string) => string][] = [
  ["import", (source) => "import " + JSON.stringify(source) + ";"],
  [
    "named export",
    (source) => "export { value } from " + JSON.stringify(source) + ";",
  ],
  ["export all", (source) => "export * from " + JSON.stringify(source) + ";"],
];

const layerCases = [
  {
    from: "config",
    allowed: ["errors"],
    denied: ["models", "providers", "repositories", "services"],
  },
  {
    from: "routes",
    allowed: ["controllers", "middlewares", "schemas", "models", "errors"],
    denied: ["services", "repositories", "providers", "config"],
  },
  {
    from: "controllers",
    allowed: ["services", "schemas", "models", "errors"],
    denied: ["routes", "middlewares", "repositories", "providers", "config"],
  },
  {
    from: "middlewares",
    allowed: ["schemas", "models", "errors"],
    denied: ["routes", "controllers", "services", "repositories", "config"],
  },
  {
    from: "schemas",
    allowed: ["errors"],
    denied: ["models", "controllers", "services", "repositories", "providers"],
  },
  {
    from: "services",
    allowed: ["models", "errors"],
    denied: ["routes", "controllers", "middlewares", "schemas", "config"],
  },
  {
    from: "repositories",
    allowed: ["models", "errors"],
    denied: ["services", "providers", "controllers", "config"],
  },
  {
    from: "providers",
    allowed: ["models", "errors"],
    denied: ["repositories", "services", "controllers", "config"],
  },
  {
    from: "models",
    allowed: ["errors"],
    denied: ["providers", "repositories", "services", "schemas", "config"],
  },
  {
    from: "errors",
    allowed: [],
    denied: ["models", "providers", "repositories", "services", "config"],
  },
];

describe.each(declarationForms)("layer direction: %s", (_, declaration) => {
  for (const row of layerCases) {
    const filename = "src/" + row.from + "/example.ts";
    if (row.allowed.length > 0) {
      it.each(row.allowed)(
        "allows " + row.from + " -> %s public API",
        (target) => {
          allows(filename, declaration("../" + target + "/index.ts"));
        },
      );
    }
    it.each(row.denied)("rejects " + row.from + " -> %s", (target) => {
      rejects(filename, declaration("../" + target + "/index.ts"));
    });
  }

  it.each([
    ["src/config/env.ts", "./helper.ts"],
    ["src/config/nested/env.ts", "../helper.ts"],
    ["src/models/password/phc.ts", "./hash-parameters.ts"],
    ["src/store/sqlite/store.ts", "./initialization.ts"],
    ["src/repositories/sqlite/sqlite-user-repository.ts", "./errors.ts"],
    ["src/providers/password/semaphore.ts", "./derive.ts"],
    ["src/providers/crypto-id-provider.test.ts", "./crypto-id-provider.ts"],
    ["src/providers/json-logger-provider.test.ts", "./json-logger-provider.ts"],
  ])("allows module internals: %s -> %s", (filename, source) => {
    allows(filename, declaration(source));
  });

  it.each([
    "./config/index.ts",
    "./controllers/index.ts",
    "./routes/index.ts",
    "./middlewares/index.ts",
    "./services/index.ts",
    "./repositories/sqlite/index.ts",
    "./providers/password/index.ts",
    "./providers/crypto-id-provider.ts",
    "./providers/json-logger-provider.ts",
    "./password/index.ts",
    "./store/sqlite/index.ts",
  ])("allows assembly through %s", (source) => {
    allows("src/index.ts", declaration(source));
  });

  it.each([
    ["src/config/env.ts", "../index.ts"],
    ["src/config/nested/env.ts", "../../index.ts"],
    ["src/services/auth-service.ts", "../index.ts"],
    ["src/services/auth-service.test.ts", "../index.ts"],
    ["src/services/auth-service.ts", "../models/password/phc.ts"],
    ["src/services/auth-service.ts", "../providers/password/index.ts"],
    ["src/services/auth-service.ts", "../providers/crypto-id-provider.ts"],
    ["src/controllers/auth-controller.ts", "../services/auth-service.ts"],
    ["src/index.ts", "./repositories/sqlite/initialization.ts"],
    ["src/index.ts", "./providers/password/derive.ts"],
    ["src/index.ts", "./password/hasher.ts"],
    ["src/models/user.ts", "./user.test.ts"],
    ["src/services/auth-service.ts", "../auth/index.ts"],
    ["src/services/auth-service.ts", "../errors.ts"],
    ["src/services/auth-service.ts", "../main.ts"],
    ["src/services/auth-service.ts", "../models/index"],
  ])("rejects non-public or obsolete paths: %s -> %s", (filename, source) => {
    rejects(filename, declaration(source));
  });

  it.each([
    "../../src/models/index.ts",
    "../../../auth-server/src/models/index.ts",
    "../models/../models/index.ts",
    "../models//index.ts",
    "crypto",
    "sqlite3",
  ])("rejects path or runtime dependency escape %s", (source) => {
    rejects(
      "src/services/auth-service.ts",
      declaration(source),
      "no-restricted-imports",
    );
  });
});

describe("layer direction through interface barrels", () => {
  const interfaceNames: Record<string, string> = {
    repositories: "UserRepository",
    providers: "LoggerProvider",
  };
  for (const row of layerCases) {
    const denied = row.denied.filter((target) => target in interfaceNames);
    if (denied.length > 0) {
      it.each(denied)(
        "rejects " + row.from + " -> %s interface types",
        (target) => {
          rejects(
            "src/" + row.from + "/example.ts",
            namedImport(
              "../" + target + "/index.ts",
              interfaceNames[target] ?? "",
              true,
            ),
          );
        },
      );
    }
  }
});

describe("interface-only public APIs", () => {
  it.each(["PasswordProvider", "IdProvider", "LoggerProvider"])(
    "allows Service type access to %s",
    (name) => {
      const filename = "src/services/auth-service.ts";
      const source = "../providers/index.ts";
      allows(filename, namedImport(source, name, true));
      allows(
        filename,
        "export type { " + name + " } from " + JSON.stringify(source) + ";",
      );
      rejects(filename, namedImport(source, name));
      rejects(filename, 'export * from "../providers/index.ts";');
      rejects(
        filename,
        'import * as providers from "../providers/index.ts"; void providers;',
      );
    },
  );

  it.each(["src/services/auth-service.ts", "src/store/sqlite/store.ts"])(
    "allows only the repository interface in %s",
    (filename) => {
      const source = sourcePath(filename, "src/repositories/index.ts");
      allows(filename, namedImport(source, "UserRepository", true));
      rejects(filename, namedImport(source, "UserRepository"));
      rejects(filename, namedImport(source, "SqliteUserRepository", true));
      rejects(filename, "export * from " + JSON.stringify(source) + ";");
    },
  );

  it("limits Middleware access to the LoggerProvider type", () => {
    const filename = "src/middlewares/error-handler.ts";
    const source = "../providers/index.ts";
    allows(filename, namedImport(source, "LoggerProvider", true));
    for (const name of [
      "PasswordProvider",
      "IdProvider",
      "JsonLoggerProvider",
    ]) {
      rejects(filename, namedImport(source, name, true));
    }
    rejects(filename, namedImport(source, "LoggerProvider"));
  });

  it.each([
    ["src/services/auth-service.ts", "../providers/index.ts"],
    ["src/services/auth-service.ts", "../providers/password/index.ts"],
    ["src/services/auth-service.ts", "../repositories/sqlite/index.ts"],
  ])("rejects concrete type access: %s -> %s", (filename, source) => {
    rejects(filename, namedImport(source, "Concrete", true));
  });

  it.each([
    ["src/providers/index.ts", "./password/index.ts", "PasswordProvider"],
    ["src/repositories/index.ts", "./sqlite/index.ts", "UserRepository"],
  ])(
    "rejects interface names taken from concrete modules: %s -> %s",
    (filename, source, name) => {
      rejects(
        filename,
        "export type { " + name + " } from " + JSON.stringify(source) + ";",
      );
    },
  );

  it("keeps interface definitions behind type-only public barrels", () => {
    rejects(
      "src/services/auth-service.ts",
      namedImport(
        "../providers/password-provider.ts",
        "PasswordProvider",
        true,
      ),
    );
    allows(
      "src/providers/index.ts",
      'export type { PasswordProvider } from "./password-provider.ts";',
    );
    rejects(
      "src/providers/index.ts",
      'export { PasswordProvider } from "./password-provider.ts";',
    );
    allows(
      "src/repositories/index.ts",
      'export type { UserRepository } from "./user-repository.ts";',
    );
  });
});

describe("interface barrel sources", () => {
  it.each(["src/providers/index.ts", "src/repositories/index.ts"])(
    "does not bypass the interface-only barrel through Node or local exports in %s",
    (filename) => {
      for (const code of [
        'export { createReadStream } from "node:fs";',
        'export type { Stats } from "node:fs";',
        'export * from "node:fs";',
        'export { expect } from "vitest";',
        "export const implementation = 1;",
        "export default {};",
      ]) {
        rejects(filename, code);
      }
    },
  );
});

describe("model secrets and targeted test exceptions", () => {
  const helpers = ["readPassword", "readHash", "createHash", "isCanonicalHash"];
  const allowed = [
    "src/models/password/values.test.ts",
    "src/password/hasher.ts",
    "src/password/hasher.test.ts",
    "src/password/concurrency.test.ts",
    "src/password/password.bench.ts",
    "src/providers/password/argon2-password-provider.ts",
  ];

  it.each(allowed)("allows only named secret helpers in %s", (filename) => {
    const source = sourcePath(filename, "src/models/password/values.ts");
    for (const name of helpers) {
      allows(
        filename,
        "import { " +
          name +
          " as helper } from " +
          JSON.stringify(source) +
          "; void helper();",
      );
    }
    for (const code of [
      namedImport(source, "validateParams"),
      namedImport(source, "readPassword") +
        " export class Leak { static read = Dependency; }",
      "import * as values from " + JSON.stringify(source) + "; void values;",
      "import values from " + JSON.stringify(source) + "; void values;",
      "import " + JSON.stringify(source) + ";",
      namedImport(source, "Password"),
      "export { readPassword } from " + JSON.stringify(source) + ";",
      "export * from " + JSON.stringify(source) + ";",
      "import { readPassword as helper } from " +
        JSON.stringify(source) +
        "; export { helper };",
      "export { helper }; import { readPassword as helper } from " +
        JSON.stringify(source) +
        ";",
      "import { readPassword as helper } from " +
        JSON.stringify(source) +
        "; export default helper;",
      namedImport(source, "readPassword") +
        " export const leaked = Dependency;",
      namedImport(source, "readPassword") +
        " const alias = Dependency; export { alias };",
      namedImport(source, "readPassword") + " export default { Dependency };",
      namedImport(source, "readPassword") +
        " export function leaked() { return Dependency; }",
    ]) {
      rejects(filename, code);
    }
    if (!filename.startsWith("src/models/")) {
      rejects(
        filename,
        namedImport(
          sourcePath(filename, "src/models/password/phc.ts"),
          "parseHash",
        ),
      );
      rejects(
        filename,
        namedImport(
          sourcePath(filename, "src/models/password/hash-parameters.ts"),
          "validateParams",
        ),
      );
    }
  });

  it.each([
    ["src/password/hasher.ts", "Hasher"],
    [
      "src/providers/password/argon2-password-provider.ts",
      "Argon2PasswordProvider",
    ],
  ])(
    "limits privileged production exports to the documented class in %s",
    (filename, name) => {
      allows(filename, "export class " + name + " {}");
      rejects(
        filename,
        'import { readPassword } from "' +
          sourcePath(filename, "src/models/password/values.ts") +
          '"; export class ' +
          name +
          " { static read = readPassword; }",
      );
      rejects(filename, "export class Other {}");
      rejects(filename, "export const " + name + " = 1;");
      rejects(filename, "export default class " + name + " {}");
    },
  );

  it.each([
    "src/models/password/bridge.ts",
    "src/models/password/phc.ts",
    "src/models/password/hash-parameters.ts",
    "src/models/password/phc.test.ts",
  ])(
    "keeps sibling models from wrapping or re-exporting secrets in %s",
    (filename) => {
      allows(filename, namedImport("./values.ts", "Password"));
      rejects(filename, namedImport("./values.ts", "readPassword"));
      rejects(filename, 'export { readPassword } from "./values.ts";');
      rejects(filename, 'export * from "./values.ts";');
      rejects(filename, 'import * as values from "./values.ts"; void values;');
      rejects(
        filename,
        'import { readPassword as helper } from "./values.ts"; export function leaked() { return helper; }',
      );
    },
  );

  it.each([
    "src/index.ts",
    "src/models/user.ts",
    "src/services/auth-service.ts",
    "src/controllers/auth-controller.ts",
    "src/repositories/sqlite/sqlite-user-repository.ts",
    "src/providers/crypto-id-provider.ts",
    "src/providers/password/derive.ts",
    "src/password/semaphore.ts",
    "src/password/unrelated.test.ts",
    "src/password/hasher.bench.ts",
    "src/store/sqlite/store.ts",
  ])("denies model secret access in %s", (filename) => {
    rejects(
      filename,
      namedImport(
        sourcePath(filename, "src/models/password/values.ts"),
        "readPassword",
      ),
    );
  });

  it("publishes model classes and types without exposing internal helpers", () => {
    allows(
      "src/models/index.ts",
      'export { Password, EncodedHash } from "./password/values.ts";',
    );
    allows(
      "src/models/index.ts",
      'export type { Params, Cost } from "./password/hash-parameters.ts";',
    );
    rejects(
      "src/models/index.ts",
      'export { readPassword as Password } from "./password/values.ts";',
    );
    rejects("src/models/index.ts", 'export * from "./password/values.ts";');
    allows(
      "src/models/index.ts",
      'export { validateParams } from "./password/hash-parameters.ts";',
    );
    rejects(
      "src/models/index.ts",
      'export { inRange } from "./password/hash-parameters.ts";',
    );
    rejects(
      "src/models/index.ts",
      'export { parseHash } from "./password/phc.ts";',
    );
  });

  it.each([
    "src/services/auth-service.test.ts",
    "src/services/auth-service.integration.test.ts",
  ])("permits a real password Provider in %s", (filename) => {
    allows(
      filename,
      namedImport("../providers/password/index.ts", "Argon2PasswordProvider"),
    );
    rejects(
      filename,
      namedImport("../providers/password/derive.ts", "deriveKey"),
    );
  });

  it.each([
    "src/services/auth-service.ts",
    "src/services/other.test.ts",
    "src/controllers/auth-controller.test.ts",
  ])("does not grant unrelated implementation access in %s", (filename) => {
    rejects(
      filename,
      namedImport("../providers/password/index.ts", "Argon2PasswordProvider"),
    );
  });
});

describe("Node module ownership", () => {
  it.each(["node:http", "node:https", "node:http2"])(
    "limits %s to HTTP boundaries",
    (source) => {
      for (const filename of [
        "src/index.ts",
        "src/routes/auth-routes.ts",
        "src/controllers/auth-controller.ts",
        "src/middlewares/read-json.ts",
      ]) {
        allows(filename, "import " + JSON.stringify(source) + ";");
      }
      for (const filename of [
        "src/services/auth-service.ts",
        "src/providers/id-provider.ts",
        "src/repositories/user-repository.ts",
        "src/models/user.ts",
        "src/errors/auth-errors.ts",
        "src/config/env.ts",
        "src/password/hasher.ts",
        "src/store/sqlite/store.ts",
      ]) {
        rejects(filename, "import " + JSON.stringify(source) + ";");
      }
    },
  );

  it("limits SQLite to implementation modules, including type-only imports", () => {
    for (const filename of [
      "src/store/sqlite/initialization.ts",
      "src/store/sqlite/store.test.ts",
      "src/repositories/sqlite/sqlite-user-repository.ts",
    ]) {
      allows(filename, namedImport("node:sqlite", "Database", true));
    }
    for (const filename of [
      "src/index.ts",
      "src/services/auth-service.ts",
      "src/repositories/user-repository.ts",
      "src/config/env.ts",
      "src/providers/password/argon2-password-provider.ts",
    ]) {
      rejects(filename, namedImport("node:sqlite", "Database", true));
    }
  });

  it("limits crypto to concrete Providers and required transitional files", () => {
    for (const filename of [
      "src/password/hasher.ts",
      "src/password/derive.ts",
      "src/password/concurrency.test.ts",
      "src/providers/password/derive.ts",
      "src/providers/crypto-id-provider.ts",
      "src/providers/crypto-id-provider.test.ts",
    ]) {
      allows(filename, namedImport("node:crypto", "randomBytes"));
    }
    for (const filename of [
      "src/index.ts",
      "src/models/password/values.ts",
      "src/services/auth-service.ts",
      "src/providers/password-provider.ts",
      "src/providers/id-provider.ts",
      "src/password/semaphore.ts",
      "src/password/unrelated.test.ts",
      "src/store/sqlite/store.ts",
    ]) {
      rejects(filename, namedImport("node:crypto", "randomBytes"));
    }
  });
});

describe("forbidden syntax and bypasses", () => {
  it.each([
    "src/services/auth-service.ts",
    "src/services/auth-service.test.ts",
  ])("retains syntax restrictions in %s", (filename) => {
    for (const code of [
      "export const value = 1 as number;",
      "export const value = [1] as const;",
      "export const value = <number>1;",
      'export const value = import("../providers/password/index.ts");',
      'export type Value = import("../providers/password/index.ts").Argon2PasswordProvider;',
      'import value = require("../providers/password/index.ts"); export { value };',
      'export const value = require("../providers/password/index.ts");',
    ]) {
      rejects(filename, code, "no-restricted-syntax");
    }
    for (const code of [
      "export const value = Math.random();",
      'export const value = process.getBuiltinModule("node:sqlite");',
      "export const value = globalThis.crypto.randomUUID();",
      'import { vi } from "vitest"; export const value = vi.importActual("../repositories/sqlite/index.ts");',
      'import { vi } from "vitest"; vi.mock("../repositories/sqlite/index.ts");',
    ]) {
      rejects(filename, code, "no-restricted-properties");
    }
    rejects(
      filename,
      "export const value = crypto.randomUUID();",
      "no-restricted-globals",
    );
    rejects(
      filename,
      "export const value: unknown = (undefined)!;",
      "@typescript-eslint/no-non-null-assertion",
    );
    rejects(
      filename,
      "export type Value = any;",
      "@typescript-eslint/no-explicit-any",
    );
  });

  it.each([
    "src/providers/password/derive.ts",
    "src/providers/password/derive.test.ts",
  ])("retains crypto and createRequire restrictions in %s", (filename) => {
    for (const name of [
      "argon2Sync",
      "getRandomValues",
      "randomFill",
      "randomFillSync",
      "randomInt",
      "webcrypto",
    ]) {
      rejects(
        filename,
        "export { " + name + ' } from "node:crypto";',
        "no-restricted-syntax",
      );
    }
    rejects(
      filename,
      'import { createRequire } from "node:module"; void createRequire;',
      "no-restricted-syntax",
    );
    rejects(
      filename,
      'import * as crypto from "node:crypto"; void crypto.argon2Sync;',
      "no-restricted-properties",
    );
    rejects(
      filename,
      'import * as module from "node:module"; void module.createRequire;',
      "no-restricted-properties",
    );
  });

  it.each([
    "src/services/auth-service.ts",
    "src/services/auth-service.test.ts",
  ])("rejects decorators in %s", (filename) => {
    rejects(
      filename,
      "export function sealed(value: unknown): unknown { return value; }\n@sealed\nexport class Service { run(): number { return 1; } }",
      "no-restricted-syntax",
    );
  });

  it("allows Vitest only in tests and benchmarks", () => {
    rejects(
      "src/services/auth-service.ts",
      'import "vitest";',
      "no-restricted-syntax",
    );
    allows("src/services/auth-service.test.ts", 'import "vitest";');
    allows("src/password/password.bench.ts", 'import "vitest";');
  });
});
