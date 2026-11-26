import { describe, expect, it } from "vitest";
import {
  capId,
  entityId,
  extId,
  fileId,
  fileOfId,
  formatId,
  infraId,
  isNodeId,
  jobId,
  kindOf,
  modId,
  parseId,
  routeId,
  screenId,
  symId,
  sysId,
} from "../src/model/ids.js";
import { NODE_KINDS } from "../src/model/types.js";

describe("node ids", () => {
  const samples = [
    capId("checkout"),
    sysId("web"),
    modId("src-payments"),
    fileId("src/pay/stripe.ts"),
    symId("src/pay/stripe.ts", "createCharge"),
    routeId("post", "/api/checkout"),
    screenId("/cart"),
    entityId("Order"),
    jobId("send-receipts"),
    extId("stripe"),
    infraId("db"),
  ];

  it("builds the documented shapes (docs/design.md §2)", () => {
    expect(samples).toEqual([
      "cap:checkout",
      "sys:web",
      "mod:src-payments",
      "file:src/pay/stripe.ts",
      "sym:src/pay/stripe.ts#createCharge",
      "route:POST /api/checkout",
      "screen:/cart",
      "entity:Order",
      "job:send-receipts",
      "ext:stripe",
      "infra:db",
    ]);
    expect(samples.map(kindOf)).toEqual([...NODE_KINDS]);
  });

  it("round-trips every kind through parseId / formatId", () => {
    for (const id of [...samples, "route:GET /api/orders/:id", "sym:src/a#b.ts#name", "file:README.md"]) {
      const p = parseId(id);
      expect(p, id).toBeDefined();
      expect(formatId(p!)).toBe(id);
    }
    expect(parseId("route:DELETE /api/orders/:id")).toEqual({ kind: "route", method: "DELETE", path: "/api/orders/:id" });
    expect(parseId("sym:src/a.ts#run")).toEqual({ kind: "sym", path: "src/a.ts", name: "run" });
  });

  it("rejects malformed ids", () => {
    for (const bad of ["", "cap:", "nope:x", "checkout", "route:/x", "route:get /x", "route:GET ", "sym:src/a.ts", "sym:#x", "sym:a.ts#"]) {
      expect(isNodeId(bad), bad).toBe(false);
    }
  });

  it("names the file of file and symbol ids only", () => {
    expect(fileOfId("file:src/a.ts")).toBe("src/a.ts");
    expect(fileOfId("sym:src/a.ts#x")).toBe("src/a.ts");
    expect(fileOfId("route:GET /x")).toBeUndefined();
  });
});
