import pg from "pg";
import { describe, expect, it } from "vitest";

import { createPostgresTypeOverrides } from "./postgres.js";

describe("createPostgresTypeOverrides", () => {
  it("keeps dates stable and returns API-compatible timestamp strings", () => {
    const types = createPostgresTypeOverrides();
    const parseDate = types.getTypeParser(
      pg.types.builtins.DATE,
    ) as unknown as (value: string) => unknown;
    const parseTimestamp = types.getTypeParser(
      pg.types.builtins.TIMESTAMP,
    ) as unknown as (value: string) => unknown;
    const parseTimestampWithTimeZone = types.getTypeParser(
      pg.types.builtins.TIMESTAMPTZ,
    ) as unknown as (value: string) => unknown;

    expect(parseDate("2026-08-10")).toBe("2026-08-10");
    expect(parseTimestamp("2026-08-10 04:34:56.123456")).toBe(
      "2026-08-10T04:34:56.123Z",
    );
    expect(
      parseTimestampWithTimeZone("2026-08-10 12:34:56.123456+08"),
    ).toBe("2026-08-10T04:34:56.123Z");
  });
});
