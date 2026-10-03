import { expect, test } from "vitest";
import { boundaryViolations, importReferences } from "../../scripts/check-boundaries";

test("boundaries resolve aliases, parent segments, re-exports and inline type queries", () => {
  for (const source of [
    'import type { X } from "@/src/server/runtime";',
    'export type { X } from "../server/runtime";',
    'type X = import("../shared/../server/runtime").X;',
  ]) expect(boundaryViolations("src/shared/types.ts", source)).toHaveLength(1);
  expect(boundaryViolations("src/client/data.ts", 'import("../server/runtime");')).toHaveLength(1);
  expect(boundaryViolations("app/components/view.tsx", 'export { X } from "../../src/server/runtime";')).toHaveLength(1);
  expect(boundaryViolations("src/server/runtime.ts", 'import { X } from "../cli/index";')).toHaveLength(1);
  expect(boundaryViolations("src/server/runtime.ts", 'import { X } from "../../tests/helpers/runtime";')).toHaveLength(1);
  expect(boundaryViolations("src/shared/helpers.ts", 'import fs from "fs/promises";')).toHaveLength(1);
  expect(boundaryViolations("src/client/data.ts", 'const fs = require("node:fs");')).toHaveLength(1);
});

test("server route and CLI may consume server code; shared types and browser data stay usable", () => {
  expect(boundaryViolations("app/api/state/route.ts", 'import { X } from "@/src/server/runtime";')).toEqual([]);
  expect(boundaryViolations("src/cli/index.ts", 'import { X } from "../server/runtime";')).toEqual([]);
  expect(boundaryViolations("src/client/data.ts", 'import type { X } from "../shared/types";')).toEqual([]);
  expect(boundaryViolations("src/shared/contract.ts", 'import type { X } from "./types";')).toEqual([]);
  expect(importReferences("sample.ts", '// import X from "../fake";\nconst value = "../not-an-import";')).toEqual([]);
});
