import { test } from "node:test";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { runAction, withCloseDate } from "../client/actions";
import { ApiError } from "../client/api";
import { accountHealth } from "../server/health";
import { workspace, WorkspaceError, recordId } from "../server/workspace";
import {
  accountDisplayName,
  emptyFilters,
  excludingFilters,
  pipelinePage,
  selectRows,
  type Row
} from "../client/pipeline";
import { amountText, HealthBadge, Pipeline } from "../client/PipelineView";

const today = "2026-11-21";
const accountId = "001000000000001AAA";
const userId = "005000000000001AAA";
const api = "/services/data/v68.0";
const healthy = {
  activity: "recent" as const,
  openCount: 1,
  nearestClose: "2026-12-05",
  decisionMaker: true
};
const json = (records: unknown[]) => Response.json({ records, done: true });

test("health checks all inputs and handles the seven-day and overdue boundaries", () => {
  assert.equal(accountHealth(healthy, today).status, "Green");
  assert.equal(
    accountHealth({ ...healthy, nearestClose: "2026-11-28" }, today).status,
    "Amber"
  );
  assert.equal(
    accountHealth({ ...healthy, nearestClose: today }, today).status,
    "Amber"
  );
  assert.equal(
    accountHealth({ ...healthy, nearestClose: "2026-11-20" }, today).status,
    "Red"
  );
  assert.equal(
    accountHealth({ ...healthy, activity: "stale" }, today).status,
    "Red"
  );
  assert.equal(
    accountHealth({ ...healthy, decisionMaker: false }, today).status,
    "Amber"
  );
  assert.equal(
    accountHealth({ ...healthy, openCount: 0, nearestClose: null }, today)
      .status,
    "Amber"
  );
});

test("unknown permissions or failed reads never produce a misleading green or stale result", () => {
  const result = accountHealth(
    {
      ...healthy,
      activity: undefined,
      nearestClose: undefined,
      decisionMaker: undefined
    },
    today
  );
  assert.equal(result.status, "Amber");
  assert.equal(result.incomplete, true);
  assert.match(result.reasons.join(" "), /Activity information is unavailable/);
  assert.doesNotMatch(result.reasons.join(" "), /No decision-maker|21 days/);
});

test("pipeline reads Salesforce continuation pages, batches account evidence, and omits restricted amount", async () => {
  const calls: string[] = [];
  const sample = Array.from({ length: 1100 }, (_, index) => ({
    Id: `006${String(index).padStart(12, "0")}AAA`,
    Name: "Renewal " + index,
    AccountId: accountId,
    StageName: "Prospecting",
    CloseDate: "2026-12-05"
  }));
  const service = workspace(async (path) => {
    calls.push(path);
    if (path.endsWith("/Opportunity/describe"))
      return Response.json({
        queryable: true,
        fields: ["Id", "Name", "AccountId", "StageName", "CloseDate"].map(
          (name) => ({ name })
        )
      });
    if (path.endsWith("/Account/describe"))
      return Response.json({ queryable: true, fields: [] });
    if (path === api + "/query/more") return json(sample.slice(1000));
    const soql = new URL(path, "https://example.com").searchParams.get("q")!;
    if (soql.includes("OwnerId =")) {
      assert.match(soql, new RegExp(userId));
      assert.doesNotMatch(soql, /Amount/);
      return Response.json({
        records: sample.slice(0, 1000),
        done: false,
        nextRecordsUrl: api + "/query/more"
      });
    }
    if (soql.includes("MIN(CloseDate)"))
      return json([
        { AccountId: accountId, openCount: 1100, nearestClose: "2026-12-05" }
      ]);
    if (soql.includes("FROM Task")) {
      assert.match(soql, /ActivityDate > 2026-10-31/);
      return json([{ AccountId: accountId, activityCount: 1 }]);
    }
    if (soql.includes("FROM Event")) return json([]);
    if (soql.includes("FROM OpportunityContactRole"))
      return json([{ Opportunity: { AccountId: accountId } }]);
    if (soql.includes("FROM Account"))
      return json([{ Id: accountId, Name: "Alder Logistics" }]);
    throw new Error("Unexpected query");
  }, new Map());

  const result = await service.pipeline(userId, today);
  assert.equal(result.rows.length, 1100);
  assert.equal(calls.length, 9);
  assert.equal(result.rows[1099].accountName, "Alder Logistics");
  assert.equal(result.rows[1099].health?.status, "Green");
  assert.equal(result.rows[1099].Amount, undefined);
  const ordered = selectRows(
    result.rows,
    { ...emptyFilters, health: "Green", stage: "Prospecting" },
    { key: "CloseDate", ascending: true }
  );
  assert.equal(ordered.length, 1100);
  assert.equal(ordered.slice(1050, 1100).length, 50);
  assert.equal(new Set(ordered.map((row) => row.Id)).size, 1100);
});

test("amounts use Salesforce currency formatting while filters use the numeric field", async () => {
  const service = workspace(async (path) => {
    if (path.endsWith("/describe"))
      return Response.json({ queryable: true, fields: [{ name: "Amount" }] });
    const soql = new URL(path, "https://example.com").searchParams.get("q")!;
    assert.match(soql, /Amount, FORMAT\(Amount\) formattedAmount/);
    return json([
      {
        Id: "a",
        Name: "Renewal",
        Amount: 75000,
        formattedAmount: "EUR 75.000,00"
      }
    ]);
  }, new Map());
  const result = await service.pipeline(userId, today);
  assert.equal(amountText(result.rows[0]), "EUR 75.000,00");
  assert.equal(amountText({ Amount: undefined }), "Unavailable");
  assert.deepEqual(
    selectRows(
      result.rows,
      { ...emptyFilters, minimum: "75000" },
      { key: "Amount", ascending: true }
    ),
    result.rows
  );
});

test("empty pipeline avoids account and activity queries", async () => {
  const requests: string[] = [];
  const service = workspace(async (path) => {
    requests.push(path);
    return path.endsWith("/describe")
      ? Response.json({ queryable: true, fields: [] })
      : json([]);
  }, new Map());
  assert.deepEqual((await service.pipeline(userId, today)).rows, []);
  assert.equal(requests.length, 2);
});

test("Salesforce quota errors receive a distinct error and record IDs reject unsafe input", async () => {
  const service = workspace(
    async () =>
      Response.json([{ errorCode: "REQUEST_LIMIT_EXCEEDED" }], { status: 403 }),
    new Map()
  );
  await assert.rejects(
    service.pipeline(userId, today),
    (error: unknown) => error instanceof WorkspaceError && error.status === 429
  );
  assert.equal(recordId(accountId), true);
  assert.equal(recordId("001' OR Name"), false);
});

test("snapshot keeps account and opportunities when activity and contacts fail", async () => {
  const service = workspace(async (path) => {
    if (path.endsWith("/Contact/describe") || path.includes("FROM+Task")) {
      return Response.json([{ errorCode: "INVALID_TYPE" }], { status: 400 });
    }
    if (path.endsWith("/describe"))
      return Response.json({
        queryable: true,
        fields: [{ name: "CloseDate" }]
      });
    const soql = new URL(path, "https://example.com").searchParams.get("q")!;
    if (soql.includes("FROM Account"))
      return json([{ Id: accountId, Name: "Alder Logistics" }]);
    if (soql.includes("MIN(CloseDate)"))
      return json([
        { AccountId: accountId, openCount: 1, nearestClose: "2026-12-05" }
      ]);
    if (soql.includes("FROM Opportunity WHERE"))
      return json([{ Id: "006000000000001AAA", Name: "Renewal" }]);
    return json([]);
  }, new Map());
  const snapshot = await service.snapshot(accountId, today);
  assert.equal(snapshot.account.Name, "Alder Logistics");
  assert.ok("data" in snapshot.opportunities);
  assert.ok("error" in snapshot.contacts);
  assert.ok("error" in snapshot.tasks);
  assert.ok("data" in snapshot.events);
  assert.ok(
    "data" in snapshot.health && snapshot.health.data.status === "Amber"
  );
});

test("filters and sorts the full pipeline before slicing a display page", () => {
  const visibility: Pick<Row, "health" | "accountName"> = {
    health: undefined,
    accountName: undefined
  };
  const rows: Row[] = [
    {
      ...visibility,
      Id: "a",
      Name: "A",
      StageName: "Proposal",
      CloseDate: "2026-12-01",
      Amount: 200
    },
    {
      ...visibility,
      Id: "b",
      Name: "B",
      StageName: "Proposal",
      CloseDate: "2026-11-30",
      Amount: 100
    },
    {
      ...visibility,
      Id: "c",
      Name: "C",
      StageName: "Qualification",
      Amount: 300
    },
    {
      ...visibility,
      Id: "d",
      Name: "D",
      StageName: "Proposal",
      CloseDate: "2026-12-01"
    }
  ];
  const filters = {
    ...emptyFilters,
    stage: "Proposal",
    health: "Unavailable",
    from: "2026-11-30",
    through: "2026-12-01",
    minimum: "100",
    maximum: "200"
  };
  assert.deepEqual(
    selectRows(rows, filters, { key: "Amount", ascending: false }).map(
      (row) => row.Id
    ),
    ["a", "b"]
  );
  assert.deepEqual(
    selectRows(
      rows,
      { ...emptyFilters, stage: "Proposal" },
      { key: "Amount", ascending: true }
    ).map((row) => row.Id),
    ["b", "a", "d"]
  );
});

const sampleAccount =
  "RW Demo 01234567-89AB-cdef-0123-456789abcdef | Cobalt Payments";
const sampleOpportunity: Row = {
  Id: "006000000000101AAA",
  Name: "Field expansion",
  AccountId: accountId,
  accountName: sampleAccount,
  StageName: "Proposal",
  CloseDate: "2026-11-16",
  Amount: 2500,
  health: {
    status: "Amber",
    reasons: ["Needs a follow-up."],
    incomplete: false
  }
};
const closeSort = { key: "CloseDate", ascending: true } as const;
const tableRows = [
  sampleOpportunity,
  ...Array.from({ length: 110 }, (_, index): Row => ({
    ...sampleOpportunity,
    Id: "other-" + index,
    Name: "Renewal " + index,
    accountName: "Ordinary account",
    CloseDate: "2026-12-01"
  }))
];

test("display names remove only the exact seed prefix and do not change record identity", () => {
  assert.equal(accountDisplayName(sampleAccount), "Cobalt Payments");
  for (const ordinary of [
    "Cobalt Payments",
    "RW Demo | Cobalt Payments",
    "RW Demo not-a-guid | Cobalt Payments",
    "Partner RW Demo 01234567-89AB-cdef-0123-456789abcdef | Cobalt Payments",
    "rw demo 01234567-89AB-cdef-0123-456789abcdef | Cobalt Payments"
  ]) {
    assert.equal(accountDisplayName(ordinary), ordinary);
  }
  assert.equal(sampleOpportunity.accountName, sampleAccount);
});

test("case-insensitive search matches displayed account or opportunity names and composes with every filter", () => {
  for (const search of [" CoBaLt PAY ", "ExPANSION"]) {
    const filters = {
      ...emptyFilters,
      search,
      stage: "Proposal",
      health: "Amber",
      from: "2026-11-15",
      through: "2026-11-21",
      minimum: "2000",
      maximum: "3000"
    };
    assert.deepEqual(selectRows(tableRows, filters, closeSort), [
      sampleOpportunity
    ]);
  }
  assert.deepEqual(
    selectRows(
      tableRows,
      { ...emptyFilters, search: "cobalt", health: "Red" },
      closeSort
    ),
    []
  );
  assert.deepEqual(
    selectRows(tableRows, { ...emptyFilters, search: "89AB-cdef" }, closeSort),
    []
  );
  const results = selectRows(
    tableRows,
    { ...emptyFilters, search: "cobalt" },
    closeSort
  );
  assert.equal(pipelinePage(results, 2).page, 0);
});

test("confirmed close-date saves follow the selected row across pages and respect exclusions", async () => {
  let committed = tableRows;
  let displayedPage = 0;
  const changed = {
    kind: "closeDate" as const,
    opportunityId: sampleOpportunity.Id,
    accountId,
    previousDate: sampleOpportunity.CloseDate!,
    date: "2026-12-05"
  };
  await runAction(
    changed,
    {
      preview: () => {
        // The table renders a pending date separately, so this sort uses committed rows.
        const page = pipelinePage(
          selectRows(committed, emptyFilters, closeSort),
          0
        );
        if (committed === tableRows)
          assert.equal(page.visible[0].Id, sampleOpportunity.Id);
      },
      confirm: () => {
        committed = withCloseDate(committed, changed);
        displayedPage = pipelinePage(
          selectRows(committed, emptyFilters, closeSort),
          0,
          sampleOpportunity.Id
        ).page;
      },
      reject: () => assert.fail("The save should succeed."),
      refresh: () => {}
    },
    async () => ({ message: "Saved" })
  );
  assert.equal(displayedPage, 2);
  const refreshed = committed.map((row) => ({ ...row }));
  const positioned = pipelinePage(
    selectRows(refreshed, emptyFilters, closeSort),
    0,
    sampleOpportunity.Id
  );
  assert.equal(positioned.page, 2);
  assert.equal(positioned.visible.at(-1)?.Id, sampleOpportunity.Id);
  assert.equal(
    pipelinePage(
      selectRows(refreshed, emptyFilters, { ...closeSort, ascending: false }),
      0,
      sampleOpportunity.Id
    ).page,
    0
  );
  const restrictive = {
    ...emptyFilters,
    through: "2026-11-21",
    search: "cobalt"
  };
  assert.equal(
    pipelinePage(
      selectRows(refreshed, restrictive, closeSort),
      0,
      sampleOpportunity.Id
    ).selectedIndex,
    -1
  );
  assert.deepEqual(excludingFilters(refreshed[0], restrictive), ["close date"]);
  const html = renderToStaticMarkup(
    createElement(Pipeline, {
      data: { today, rows: refreshed, accountWarning: undefined },
      selected: sampleOpportunity.Id,
      follow: { id: sampleOpportunity.Id },
      onFollow: () => {},
      onLeaveFollow: () => {},
      onSelect: () => {}
    })
  );
  assert.match(html, /class="selected"/);
  assert.match(html, /aria-pressed="true">Field expansion/);
  assert.match(html, /Page 3 of 3/);
  assert.match(html, /Cobalt Payments/);
  assert.doesNotMatch(html, /01234567-89AB/);
});

test("failed close-date preview leaves the sorted selected row on its original page", async () => {
  const filters = { ...emptyFilters, through: "2026-11-21" };
  const changed = {
    kind: "closeDate" as const,
    opportunityId: sampleOpportunity.Id,
    accountId,
    previousDate: sampleOpportunity.CloseDate!,
    date: "2026-12-05"
  };
  let displayedDate = changed.previousDate;
  let rejected = false;
  await runAction(
    changed,
    {
      preview: (change) => {
        displayedDate = change?.date ?? changed.previousDate;
        const page = pipelinePage(
          selectRows(tableRows, filters, closeSort),
          0,
          sampleOpportunity.Id
        );
        assert.equal(page.page, 0);
        assert.equal(page.visible[0].Id, sampleOpportunity.Id);
      },
      confirm: () =>
        assert.fail("A failed save must not change committed dates."),
      reject: () => {
        rejected = true;
      },
      refresh: () =>
        assert.fail("A known validation rejection needs no reconciliation.")
    },
    async () => {
      assert.equal(displayedDate, changed.date);
      throw new ApiError(422, "Date rejected");
    }
  );
  assert.equal(rejected, true);
  assert.equal(displayedDate, changed.previousDate);
});

test("health badges render a decorative dot and meaningful text for each classification", () => {
  for (const [status, label] of [
    ["Green", "Healthy"],
    ["Amber", "At risk"],
    ["Red", "Needs attention"]
  ] as const) {
    const html = renderToStaticMarkup(
      createElement(HealthBadge, {
        health: { status, reasons: [], incomplete: false }
      })
    );
    assert.match(html, /health-dot" aria-hidden="true"/);
    assert.ok(html.includes(label));
  }
});
