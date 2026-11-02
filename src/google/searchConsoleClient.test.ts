import { test } from "node:test";
import assert from "node:assert/strict";
import { fetchSearchAnalytics, GSC_ROW_LIMIT, type GscQueryFn } from "./searchConsoleClient";

type Body = Parameters<GscQueryFn>[0];

function fakeRows(n: number, date = "2026-10-01") {
  return Array.from({ length: n }, (_, i) => ({
    keys: [date, `https://miwebdeboda.com/test-${i}`],
    clicks: 1,
    impressions: 10,
    ctr: 0.1,
    position: 5,
  }));
}

test("pagina hasta que un lote trae menos de 25000", async () => {
  const calls: Body[] = [];
  const query: GscQueryFn = async (body) => {
    calls.push(body);
    const n = calls.length < 3 ? GSC_ROW_LIMIT : 7;
    return { rows: fakeRows(n) };
  };
  const { rows } = await fetchSearchAnalytics(
    { startDate: "2026-10-01", endDate: "2026-10-01", type: "web", dimensions: ["date", "page"] },
    { query }
  );
  assert.equal(calls.length, 3);
  assert.deepEqual(
    calls.map((c) => c.startRow),
    [0, GSC_ROW_LIMIT, 2 * GSC_ROW_LIMIT]
  );
  assert.ok(calls.every((c) => c.rowLimit === GSC_ROW_LIMIT && c.type === "web" && c.dataState === "final"));
  assert.equal(rows.length, 2 * GSC_ROW_LIMIT + 7);
});

test("mapea keys por dimension", async () => {
  let seen: Body | undefined;
  const query: GscQueryFn = async (body) => {
    seen = body;
    return {
      rows: [
        { keys: ["2026-10-02", "https://miwebdeboda.com/test-a", "mobile", "esp"], clicks: 3, impressions: 40, ctr: 0.075, position: 2.5 },
      ],
    };
  };
  const { rows } = await fetchSearchAnalytics(
    {
      startDate: "2026-10-02",
      endDate: "2026-10-02",
      type: "web",
      dimensions: ["date", "page", "device", "country"],
      dataState: "all",
    },
    { query }
  );
  assert.equal(seen?.dataState, "all");
  assert.deepEqual(seen?.dimensions, ["date", "page", "device", "country"]);
  assert.deepEqual(rows, [
    {
      keys: { date: "2026-10-02", page: "https://miwebdeboda.com/test-a", device: "mobile", country: "esp" },
      clicks: 3,
      impressions: 40,
      ctr: 0.075,
      position: 2.5,
    },
  ]);
});

test("position ausente es null", async () => {
  const query: GscQueryFn = async () => ({
    rows: [{ keys: ["2026-10-03", "https://miwebdeboda.com/test-b"], clicks: 0, impressions: 5, ctr: 0 }],
  });
  const { rows } = await fetchSearchAnalytics(
    { startDate: "2026-10-03", endDate: "2026-10-03", type: "discover", dimensions: ["date", "page"] },
    { query }
  );
  assert.equal(rows[0].position, null);
});

test("rechaza query en discover y googleNews", async () => {
  let called = false;
  const query: GscQueryFn = async () => {
    called = true;
    return { rows: [] };
  };
  for (const type of ["discover", "googleNews"] as const) {
    await assert.rejects(
      fetchSearchAnalytics(
        { startDate: "2026-10-01", endDate: "2026-10-01", type, dimensions: ["date", "page", "query"] },
        { query }
      ),
      /query/
    );
  }
  assert.equal(called, false);
  // En image sí se admite
  await fetchSearchAnalytics(
    { startDate: "2026-10-01", endDate: "2026-10-01", type: "image", dimensions: ["date", "page", "query"] },
    { query }
  );
  assert.equal(called, true);
});

test("cuenta filas por fecha", async () => {
  const query: GscQueryFn = async () => ({
    rows: [...fakeRows(3, "2026-10-01"), ...fakeRows(2, "2026-10-02")],
  });
  const { rowsByDate } = await fetchSearchAnalytics(
    { startDate: "2026-10-01", endDate: "2026-10-02", type: "video", dimensions: ["date", "page"] },
    { query }
  );
  assert.equal(rowsByDate.get("2026-10-01"), 3);
  assert.equal(rowsByDate.get("2026-10-02"), 2);
  assert.equal(rowsByDate.size, 2);
});
