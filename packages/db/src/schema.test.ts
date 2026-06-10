import { getTableName, isTable } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import * as schema from "./schema.js";

const EXPECTED_TABLES = [
  "users",
  "teams",
  "team_members",
  "apps",
  "api_keys",
  "budgets",
  "providers",
  "channels",
  "models",
  "model_channels",
  "usage_records",
  "ledger_entries",
  "request_logs",
] as const;

describe("schema", () => {
  it("13 张表全部定义", () => {
    const names = Object.values(schema)
      .filter((v) => isTable(v))
      .map((t) => getTableName(t as never));
    for (const expected of EXPECTED_TABLES) {
      expect(names).toContain(expected);
    }
    expect(names).toHaveLength(EXPECTED_TABLES.length);
  });
});
