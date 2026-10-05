import * as Arr from "effect/Array";
import { describe, expect, it } from "vitest";

/**
 * The operation catalog is built at module load: every `op({ id })` looks its
 * route up in `ROUTE_CATALOG` and reads the method off the answer. An id that
 * names no route therefore throws while the module is still being imported,
 * which every other test file experiences as a collection failure rather than
 * a failing assertion. A collection failure produces no test result, so a
 * mutation run has nothing to attribute the kill to and records the broken id
 * as a survivor.
 *
 * This file imports the catalog dynamically, inside the test body, and imports
 * nothing from `src/` at the top level. That keeps the file collectable no
 * matter what the catalog does, so the throw lands on an assertion.
 *
 * The first import transforms the whole catalog, generated schemas included,
 * inside the test body. A cold run can pass the default 5s timeout, so the
 * file allows longer.
 */
describe("operation catalog module load", { timeout: 30_000 }, () => {
  it("builds every operation without throwing", async () => {
    const catalog = await import("../src/operations/catalog.ts");
    expect(catalog.LUCA_OPERATIONS.length).toBeGreaterThan(0);
  });

  it("gives every operation an id that names a real allowlisted route", async () => {
    const [{ LUCA_OPERATIONS }, { ROUTE_CATALOG }] = await Promise.all([
      import("../src/operations/catalog.ts"),
      import("../src/generated/route-catalog.ts"),
    ]);

    Arr.forEach(LUCA_OPERATIONS, (operation) => {
      expect(Object.hasOwn(ROUTE_CATALOG, operation.id)).toBe(true);
    });
  });

  it("registers each operation exactly once", async () => {
    const { LUCA_OPERATIONS } = await import("../src/operations/catalog.ts");
    const ids = LUCA_OPERATIONS.map((operation) => operation.id);
    expect(Arr.dedupe(ids)).toHaveLength(ids.length);
  });

  it("builds the task tool catalog without throwing", async () => {
    const { LUCA_TASK_TOOLS } = await import("../src/task-tools.ts");
    expect(LUCA_TASK_TOOLS.length).toBeGreaterThan(0);
  });
});
