import { opportunityHealth } from "../server/opportunity-health";
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
  activeDimensions,
  emptyFilters,
  excludingFilters,
  healthCounts,
  pipelinePage,
  decodePipeline,
  selectRows,
  type Row
} from "../client/pipeline";
import { amountText, HealthBadge, Pipeline } from "../client/PipelineView";
import { Snapshot } from "../client/Snapshot";
import { WorkspaceSidebar } from "../client/WorkspaceSidebar";
import { OpportunityContext } from "../client/OpportunityContext";
import { SelectionPlaceholder } from "../client/SelectionPlaceholder";

test("initial Pipeline loading and failure never show the empty-selection prompt", () => {
  const render = (loading: boolean, hasPipeline: boolean) =>
    renderToStaticMarkup(
      createElement(SelectionPlaceholder, { loading, hasPipeline })
    );
  const loading = render(true, false);
  assert.match(loading, /selection-skeleton/);
  assert.doesNotMatch(loading, /Select an opportunity/);
  assert.equal(render(false, false), "");
  assert.match(render(false, true), /Select an opportunity/);
});

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

test("Snapshot uses readable contact titles and distinguishes selected, other, and unknown role scope", async () => {
  const chosen = "006000000000001AAA";
  const other = "006000000000002AAA";
  const contacts = [
    {
      Id: "003000000000001AAA",
      Name: "Visible contact A",
      Title: "Budget owner"
    },
    {
      Id: "003000000000002AAA",
      Name: "Visible contact B",
      Title: "Operations lead"
    }
  ];
  for (const [titleReadable, rolesReadable] of [
    [true, true],
    [false, false]
  ]) {
    const service = workspace(async (path) => {
      if (path.endsWith("/describe"))
        return Response.json({
          queryable: true,
          fields:
            path.includes("/Contact/") && titleReadable
              ? [{ name: "Title" }]
              : []
        });
      const soql = new URL(path, "https://example.com").searchParams.get("q")!;
      if (soql.includes("FROM Account"))
        return json([{ Id: accountId, Name: "Demo account" }]);
      if (soql.includes("FROM Contact WHERE")) {
        assert.ok(soql.includes(", Title") === titleReadable);
        assert.ok(soql.includes(accountId));
        return json(
          titleReadable
            ? contacts
            : contacts.map(({ Id, Name }) => ({ Id, Name }))
        );
      }
      if (soql.startsWith("SELECT ContactId, OpportunityId")) {
        assert.match(soql, /Opportunity\.IsClosed = false/);
        if (!rolesReadable)
          return Response.json([{ errorCode: "INVALID_FIELD" }], {
            status: 400
          });
        return json([
          { ContactId: contacts[0].Id, OpportunityId: chosen },
          { ContactId: contacts[0].Id, OpportunityId: other },
          { ContactId: contacts[1].Id, OpportunityId: other }
        ]);
      }
      return json([]);
    }, new Map());
    const snapshot = await service.snapshot(accountId, today, chosen);
    const html = renderToStaticMarkup(
      createElement(Snapshot, { data: snapshot })
    );
    if (rolesReadable) {
      assert.deepEqual(snapshot.selectedDecisionMakerIds, [contacts[0].Id]);
      assert.deepEqual(
        snapshot.decisionMakerIds,
        contacts.map(({ Id }) => Id)
      );
      assert.match(
        html,
        /Visible contact A<\/strong><span[^>]*>Decision maker · This opportunity<\/span>/
      );
      assert.match(
        html,
        /Visible contact B<\/strong><span[^>]*>Decision maker · Other opportunity<\/span>/
      );
      assert.match(html, /Budget owner/);
      assert.match(html, /Operations lead/);
      // A server started before the new per-contact field still returns the
      // account-wide IDs and the selected-opportunity yes/no flag.
      const legacy = JSON.parse(
        JSON.stringify({
          ...snapshot,
          selectedDecisionMakerIds: undefined,
          decisionMakerIds: [contacts[0].Id],
          selectedDecisionMaker: false
        })
      ) as typeof snapshot;
      const renderLegacy = (selectedDecisionMaker: boolean | undefined) =>
        renderToStaticMarkup(
          createElement(Snapshot, {
            data: { ...legacy, selectedDecisionMaker }
          })
        );
      assert.match(
        renderLegacy(false),
        /Visible contact A<\/strong><span[^>]*>Decision maker · Other opportunity<\/span>/
      );
      assert.doesNotMatch(renderLegacy(true), /contact-role/);
      assert.doesNotMatch(renderLegacy(undefined), /contact-role/);
    } else {
      assert.equal(snapshot.selectedDecisionMakerIds, undefined);
      assert.equal(snapshot.selectedDecisionMaker, undefined);
      assert.doesNotMatch(html, /contact-role|Budget owner|Operations lead/);
      assert.match(html, /Visible contact A/);
    }
  }
});

test("missing Task due-date access preserves the readable task and does not manufacture stale activity", async () => {
  const service = workspace(async (path) => {
    if (path.endsWith("/describe")) {
      return Response.json({
        queryable: true,
        fields: path.includes("/Task/")
          ? [{ name: "Subject" }]
          : [{ name: "CloseDate" }]
      });
    }
    const soql = new URL(path, "https://example.com").searchParams.get("q")!;
    if (soql.includes("FROM Account"))
      return json([{ Id: accountId, Name: "Northstar Lab" }]);
    if (soql.includes("MIN(CloseDate)"))
      return json([
        { AccountId: accountId, openCount: 2, nearestClose: "2026-11-15" }
      ]);
    if (soql.includes("FROM Task") && soql.includes("COUNT(Id)"))
      return Response.json([{ errorCode: "INVALID_FIELD" }], { status: 400 });
    if (soql.includes("FROM Task")) {
      assert.doesNotMatch(soql, /ActivityDate/);
      assert.match(soql, /AccountId.*IsClosed = true/);
      return json([
        { Id: "00T000000000001AAA", Subject: "Completed discovery" }
      ]);
    }
    if (soql.includes("SELECT Opportunity.AccountId"))
      return json([{ Opportunity: { AccountId: accountId } }]);
    return json([]);
  }, new Map());
  const snapshot = await service.snapshot(accountId, today);
  assert.ok("data" in snapshot.tasks);
  assert.equal(snapshot.tasks.datesUnavailable, true);
  assert.equal(snapshot.tasks.data[0]?.ActivityDate, undefined);
  assert.ok("data" in snapshot.health);
  assert.equal(snapshot.health.data.status, "Red");
  assert.equal(snapshot.health.data.incomplete, true);
  assert.equal(snapshot.health.data.activity, undefined);
  assert.ok(
    snapshot.health.data.reasons.includes(
      "A visible open opportunity is overdue."
    )
  );
  assert.doesNotMatch(
    snapshot.health.data.reasons.join(" "),
    /21 days|No completed task/
  );
  const html = renderToStaticMarkup(
    createElement(Snapshot, { data: snapshot })
  );
  assert.match(html, /Task dates are unavailable/);
  assert.match(html, /Completed discovery/);
});

test("unknown evidence alone renders a neutral Not assessed label, while confirmed risk stays distinct", () => {
  const unknown = accountHealth(
    { ...healthy, activity: undefined, decisionMaker: undefined },
    today
  );
  assert.equal(unknown.unassessed, true);
  assert.match(
    renderToStaticMarkup(createElement(HealthBadge, { health: unknown })),
    /Not assessed/
  );
  const knownRisk = accountHealth(
    { ...healthy, activity: undefined, decisionMaker: false },
    today
  );
  assert.equal(knownRisk.unassessed, false);
  assert.match(
    renderToStaticMarkup(createElement(HealthBadge, { health: knownRisk })),
    /At risk/
  );
});

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
    if (soql.includes("FROM OpportunityContactRole")) {
      assert.match(soql, /WHERE Role = 'Decision Maker' AND OpportunityId IN/);
      const ids = soql.match(/006[0-9]{12}AAA/g) ?? [];
      assert.ok(ids.length <= 175);
      return json(
        ids
          .filter((id) => id !== sample[0].Id)
          .map((OpportunityId) => ({ OpportunityId }))
      );
    }
    if (soql.includes("FROM Account"))
      return json([{ Id: accountId, Name: "Alder Logistics" }]);
    throw new Error("Unexpected query");
  }, new Map());

  const result = await service.pipeline(userId, today);
  assert.equal(result.rows.length, 1100);
  assert.equal(calls.length, 12);
  assert.equal(result.rows[0].health.status, "Amber");
  assert.equal(result.rows[1099].accountName, "Alder Logistics");
  assert.equal(result.rows[1099].health?.status, "Green");
  assert.equal(result.rows[1099].Amount, undefined);
  assert.equal(result.amountAvailable, false);
  const ordered = selectRows(
    result.rows,
    { ...emptyFilters, health: "Green", stage: "Prospecting" },
    { key: "CloseDate", ascending: true }
  );
  assert.equal(ordered.length, 1099);
  assert.equal(ordered.slice(1050, 1100).length, 49);
  assert.equal(new Set(ordered.map((row) => row.Id)).size, 1099);
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
    health: opportunityHealth(undefined, undefined, today),
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
    reasonCodes: ["missingDecisionMaker"],
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
      data: {
        today,
        rows: refreshed,
        accountWarning: undefined,
        healthScope: "opportunity",
        amountAvailable: true
      },
      selected: sampleOpportunity.Id,
      follow: { id: sampleOpportunity.Id },
      onFollow: () => {},
      onLeaveFollow: () => {},
      onSelect: () => {}
    })
  );
  assert.match(html, /class="selected"/);
  assert.match(
    html,
    /aria-pressed="true" title="Field expansion">Field expansion/
  );
  assert.match(html, /Page 3 of 3/);
  assert.match(html, /aria-disabled="true" aria-label="Next pipeline page"/);
  assert.match(
    html,
    /aria-disabled="false" aria-label="Previous pipeline page"/
  );
  assert.match(html, /Cobalt Payments/);
  assert.doesNotMatch(html, /01234567-89AB/);
});

test("malformed query pages and repeated Salesforce cursors stop with safe errors", async () => {
  const invalid = workspace(
    async () => Response.json({ records: [], done: "false" }),
    new Map()
  );
  await assert.rejects(invalid.query("SELECT Id FROM Opportunity"), {
    status: 502
  });
  let reads = 0;
  const cyclic = workspace(async () => {
    reads++;
    return Response.json({
      records: [],
      done: false,
      nextRecordsUrl: api + "/query/repeated"
    });
  }, new Map());
  await assert.rejects(cyclic.query("SELECT Id FROM Opportunity"), {
    status: 502
  });
  assert.equal(reads, 2);
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

test("unreadable Amount is labeled without exposing filter or sort controls", () => {
  const html = renderToStaticMarkup(
    createElement(Pipeline, {
      data: {
        today,
        healthScope: "opportunity",
        amountAvailable: false,
        accountWarning: undefined,
        rows: [{ ...sampleOpportunity, Amount: undefined }]
      },
      onSelect: () => {},
      onFollow: () => {},
      onLeaveFollow: () => {}
    })
  );
  assert.match(html, /Amount filters are unavailable/);
  assert.doesNotMatch(html, /Min amount|Max amount|class="sort">Amount/);
  assert.match(
    html,
    /<td><span class="cell-text" title="Unavailable">Unavailable<\/span><\/td>/
  );
});

test("quick health counts use all matching rows before health and pagination", () => {
  const green = opportunityHealth("2026-12-10", true, today);
  const row = {
    ...sampleOpportunity,
    Name: "Renewal",
    StageName: "Negotiation",
    CloseDate: today,
    Amount: 100
  };
  const rows: Row[] = [
    ...Array.from({ length: 51 }, (_, index) => ({
      ...row,
      Id: String(index),
      health: { ...green, reasons: [] }
    })),
    {
      ...row,
      Id: "unassessed",
      health: {
        status: "Amber",
        unassessed: true,
        reasonCodes: [],
        incomplete: true,
        reasons: []
      }
    },
    {
      ...row,
      Id: "missing",
      health: opportunityHealth(undefined, undefined, today)
    },
    { ...row, Id: "different-stage", StageName: "Prospecting" },
    { ...row, Id: "different-name", Name: "Expansion" },
    { ...row, Id: "different-date", CloseDate: "2026-11-22" },
    { ...row, Id: "different-amount", Amount: 99 }
  ];
  const filters = {
    ...emptyFilters,
    search: "  ReNeWAL ",
    stage: "Negotiation",
    from: today,
    through: today,
    minimum: "100",
    maximum: "100",
    health: "Unavailable"
  };
  assert.deepEqual(healthCounts(rows, filters), {
    All: 53,
    Green: 51,
    Amber: 0,
    Red: 0
  });
  assert.deepEqual(
    selectRows(rows, filters, { key: "CloseDate", ascending: true }).map(
      ({ Id }) => Id
    ),
    ["missing", "unassessed"]
  );
  assert.deepEqual(
    activeDimensions(filters).map(({ label, keys }) => [label, keys]),
    [
      ["Stage", ["stage"]],
      ["Close date", ["from", "through"]],
      ["Amount", ["minimum", "maximum"]],
      ["Health", ["health"]]
    ]
  );
  assert.deepEqual(
    activeDimensions({ ...emptyFilters, search: "Renewal" }),
    []
  );
});

test("workspace controls start collapsed and preserve restricted table semantics", () => {
  const sidebar = renderToStaticMarkup(
    createElement(WorkspaceSidebar, {
      username: "rep.workspace@example.com",
      signingOut: false,
      signOut: () => {}
    })
  );
  assert.match(sidebar, /aria-expanded="false".*aria-label="Expand sidebar"/);
  assert.match(
    sidebar,
    /class="sidebar-header".*class="sidebar-toggle".*<\/div><nav/
  );
  assert.match(sidebar, /id="workspace-user" hidden/);
  const markup = renderToStaticMarkup(
    createElement(Pipeline, {
      data: {
        today,
        healthScope: "opportunity",
        amountAvailable: false,
        rows: [sampleOpportunity],
        accountWarning: undefined
      },
      onSelect: () => {},
      onFollow: () => {},
      onLeaveFollow: () => {}
    })
  );
  assert.match(
    markup,
    /aria-expanded="false" aria-controls="advanced-filters"/
  );
  assert.match(markup, /id="advanced-filters" hidden/);
  assert.match(markup, /Amount filters are unavailable/);
  assert.match(markup, /<th scope="col">Amount<\/th>/);
  assert.match(markup, /<button class="sort">Account /);
  assert.match(markup, /<button class="sort">Opportunity /);
  assert.doesNotMatch(markup, /Rows per page|Min amount|Filters \(4\)/);
});

test("selectable rows retain one native selection button and context uses the selected row", () => {
  const first = { ...sampleOpportunity, Name: "Selected renewal" };
  const second = { ...first, Id: "second", Name: "Another renewal" };
  const unavailable = {
    ...first,
    Id: "missing",
    Name: "Without Account",
    accountName: undefined
  };
  const html = renderToStaticMarkup(
    createElement(Pipeline, {
      data: {
        today,
        healthScope: "opportunity",
        amountAvailable: true,
        rows: [first, second, unavailable],
        accountWarning: undefined
      },
      selected: second.Id,
      onSelect: () => {},
      onFollow: () => {},
      onLeaveFollow: () => {}
    })
  );
  assert.equal((html.match(/data-selectable="true"/g) ?? []).length, 2);
  assert.match(
    html,
    /<tr class="selected" data-selectable="true"><th scope="row"><button type="button" class="opportunity" aria-pressed="true" aria-describedby="close-date-overdue-second" title="Another renewal">Another renewal/
  );
  assert.doesNotMatch(html, /<tr[^>]*(?:tabindex|role=)/);
  const context = renderToStaticMarkup(
    createElement(OpportunityContext, {
      row: {
        ...second,
        StageName: "Id. Decision Makers",
        Amount: undefined,
        health: opportunityHealth(undefined, undefined, today)
      },
      onReturn: () => {}
    })
  );
  assert.match(
    context,
    /<h2 id="selected-title" tabindex="-1">Another renewal/
  );
  assert.match(context, /<dd>Id\. Decision Makers<\/dd>/);
  assert.doesNotMatch(context, /Account health|context-health/);
  assert.match(context, /<dd>Unavailable<\/dd>/);
});

test("pipeline keeps a machine-readable date and labeled inline overdue warning", () => {
  const html = renderToStaticMarkup(
    createElement(Pipeline, {
      data: {
        today,
        healthScope: "opportunity",
        amountAvailable: true,
        rows: [
          sampleOpportunity,
          { ...sampleOpportunity, Id: "upcoming", CloseDate: "2026-12-05" }
        ],
        accountWarning: undefined
      },
      onSelect: () => {},
      onFollow: () => {},
      onLeaveFollow: () => {}
    })
  );
  assert.match(
    html,
    /<div class="table-close-date is-overdue" title="Overdue — close date has passed"><time dateTime="2026-11-16">[^<]+<\/time>/
  );
  assert.match(html, /aria-describedby="close-date-overdue-[^"]+"/);
  assert.match(
    html,
    /class="visually-hidden">Overdue — close date has passed<\/span>/
  );
  assert.match(html, /<time dateTime="2026-12-05"[^>]*>[^<]+<\/time><\/div>/);
});

test("search matches every normalized token across Opportunity and Account names", () => {
  const matching = {
    ...sampleOpportunity,
    Name: "Pioneer Packaging - Renewal 19",
    accountName: "RW Demo 01234567-89AB-cdef-0123-456789abcdef | Café Group"
  };
  const sibling = {
    ...matching,
    Id: "2",
    Name: "Pioneer Packaging - Expansion"
  };
  for (const search of [
    "Pioneer Renewal",
    " renewal\t PÍONEER ",
    "cafe renewal"
  ]) {
    assert.deepEqual(
      selectRows([sibling, matching], { ...emptyFilters, search }, closeSort),
      [matching]
    );
  }
  for (const search of ["Pioneer missing", "RW Demo Renewal"]) {
    assert.deepEqual(
      selectRows([matching], { ...emptyFilters, search }, closeSort),
      []
    );
  }
});

test("Opportunity and displayed Account sort in both directions with stable ties and missing accounts last", () => {
  const rows = [
    { ...sampleOpportunity, Id: "3", Name: "Zulu", accountName: "Alder" },
    { ...sampleOpportunity, Id: "2", Name: "Alpha", accountName: "Beryl" },
    {
      ...sampleOpportunity,
      Id: "1",
      Name: "Alpha",
      accountName: "RW Demo 01234567-89AB-cdef-0123-456789abcdef | Alder"
    },
    { ...sampleOpportunity, Id: "4", Name: "Beta", accountName: undefined }
  ];
  const order = (key: "Name" | "accountName", ascending: boolean) =>
    selectRows(rows, emptyFilters, { key, ascending }).map((row) => row.Id);
  assert.deepEqual(order("Name", true), ["1", "2", "4", "3"]);
  assert.deepEqual(order("Name", false), ["3", "4", "1", "2"]);
  assert.deepEqual(order("accountName", true), ["1", "3", "2", "4"]);
  assert.deepEqual(order("accountName", false), ["2", "1", "3", "4"]);
});

test("opportunity health uses calendar boundaries and preserves known risk with partial evidence", () => {
  const assess = (date: string | undefined, covered: boolean | undefined) =>
    opportunityHealth(date, covered, "2026-03-26");
  assert.deepEqual(assess("2026-04-02", false).reasonCodes, [
    "closingSoon",
    "missingDecisionMaker"
  ]);
  assert.equal(assess("2026-04-02", false).status, "Red");
  assert.equal(assess("2026-04-02", undefined).status, "Amber");
  assert.equal(assess("2026-04-03", true).status, "Green");
  assert.equal(assess("2026-04-03", false).status, "Amber");
  assert.equal(assess("2026-04-03", undefined).unassessed, true);
  assert.equal(assess("2026-03-25", undefined).status, "Red");
  assert.equal(assess("2026-03-26", true).status, "Amber");
  assert.equal(assess("2026-02-30", true).unassessed, true);
  assert.equal(assess(undefined, false).status, "Amber");
  assert.equal(assess(undefined, undefined).unassessed, true);
});

test("a failed role query preserves overdue evidence without inventing missing coverage", async () => {
  for (const incomplete of [false, true]) {
    const service = workspace(async (path) => {
      if (path.endsWith("/Opportunity/describe"))
        return Response.json({
          queryable: true,
          fields: [{ name: "CloseDate" }, { name: "AccountId" }]
        });
      if (path.endsWith("/Account/describe"))
        return Response.json({ queryable: true, fields: [] });
      const soql = new URL(path, "https://example.com").searchParams.get("q")!;
      if (soql.includes("FROM OpportunityContactRole"))
        return incomplete
          ? Response.json({
              records: [{ OpportunityId: "006000000000001AAA" }],
              done: false
            })
          : Response.json([{ errorCode: "INVALID_FIELD" }], { status: 400 });
      if (soql.includes("FROM Account"))
        return json([{ Id: accountId, Name: "Example" }]);
      return json([
        {
          Id: "006000000000001AAA",
          AccountId: accountId,
          Name: "Overdue",
          CloseDate: "2026-11-20"
        },
        {
          Id: "006000000000002AAA",
          AccountId: accountId,
          Name: "Later",
          CloseDate: "2026-12-20"
        }
      ]);
    }, new Map());
    const result = await service.pipeline(userId, today);
    assert.deepEqual(
      result.rows.map((row) => row.health.reasonCodes),
      [["overdue", "unknownDecisionMaker"], ["unknownDecisionMaker"]]
    );
    assert.equal(result.rows[0].health.status, "Red");
    assert.equal(result.rows[1].health.unassessed, true);
    const html = renderToStaticMarkup(
      createElement(Pipeline, {
        data: result,
        onSelect: () => {},
        onFollow: () => {},
        onLeaveFollow: () => {}
      })
    );
    assert.match(html, /Opportunity health for Later: Unavailable/);
    assert.match(html, /aria-expanded="false"/);
  }
});

test("a 1,080-row legacy response is rejected instead of showing an all-unavailable pipeline", () => {
  const rows = Array.from({ length: 1080 }, () => ({
    ...sampleOpportunity,
    health: {
      status: "Red",
      reasons: ["Account is overdue"],
      incomplete: false
    }
  }));
  const response = { today, amountAvailable: true, rows };
  assert.throws(() => decodePipeline(response), /different Pipeline versions/);
  assert.throws(
    () => decodePipeline({ ...response, healthScope: "opportunity" }),
    /different Pipeline versions/
  );
  assert.throws(
    () => decodePipeline({ ...response, rows: [] }),
    /different Pipeline versions/
  );
});

test("decoded health drives badge text, counts, sorting and filtering together", () => {
  const evidence = [
    ["Unknown role on overdue", "2026-11-16", undefined],
    ["Covered overdue", "2026-11-17", true],
    ["Upcoming unknown", "2026-11-25", undefined],
    ["Healthy covered", "2026-12-10", true],
    ["Missing coverage", "2026-12-10", false],
    ["Unknown future", "2026-12-10", undefined]
  ] as const;
  const rows = evidence.map(([Name, CloseDate, covered], index) => ({
    ...sampleOpportunity,
    Id: String(index),
    Name,
    CloseDate,
    health: opportunityHealth(CloseDate, covered, today)
  }));
  const data = decodePipeline(
    JSON.parse(
      JSON.stringify({
        healthScope: "opportunity",
        today,
        amountAvailable: true,
        rows
      })
    )
  );
  assert.deepEqual(healthCounts(data.rows, emptyFilters), {
    All: 6,
    Green: 1,
    Amber: 2,
    Red: 2
  });
  const sort = { key: "health", ascending: true } as const;
  assert.deepEqual(
    selectRows(data.rows, emptyFilters, sort).map(({ Id }) => Id),
    ["0", "1", "2", "4", "3", "5"]
  );
  assert.deepEqual(
    selectRows(data.rows, { ...emptyFilters, health: "Red" }, sort).map(
      ({ Id }) => Id
    ),
    ["0", "1"]
  );
  const html = renderToStaticMarkup(
    createElement(Pipeline, {
      data,
      onSelect: () => {},
      onFollow: () => {},
      onLeaveFollow: () => {}
    })
  );
  assert.match(html, /Opportunity health for Covered overdue: Needs attention/);
  assert.match(html, /Opportunity health for Upcoming unknown: At risk/);
  assert.match(html, /Opportunity health for Healthy covered: Healthy/);
  assert.match(html, /Opportunity health for Unknown future: Unavailable/);
});

test("an impossible Account close date is unknown, while confirmed stale activity stays critical", () => {
  const evidence = {
    activity: "recent" as const,
    openCount: 1,
    nearestClose: "2026-02-30",
    decisionMaker: true
  };
  const unknown = accountHealth(evidence, today);
  assert.equal(unknown.unassessed, true);
  assert.deepEqual(unknown.reasons, ["Close-date information is unavailable."]);
  assert.equal(
    accountHealth({ ...evidence, activity: "stale" }, today).status,
    "Red"
  );
});

test("prioritization by reason distinguishes overdue from near-term risks within the same status", () => {
  const rows = [
    {
      ...sampleOpportunity,
      Id: "past",
      health: opportunityHealth("2026-11-16", true, today)
    },
    {
      ...sampleOpportunity,
      Id: "near",
      health: opportunityHealth("2026-11-25", false, today)
    },
    {
      ...sampleOpportunity,
      Id: "later",
      health: opportunityHealth("2026-12-19", false, today)
    }
  ];
  const filters = { ...emptyFilters, health: "Red", reason: "closingSoon" };
  assert.deepEqual(
    selectRows(rows, filters, closeSort).map(({ Id }) => Id),
    ["near"]
  );
  assert.deepEqual(healthCounts(rows, filters), {
    All: 1,
    Green: 0,
    Amber: 0,
    Red: 1
  });
  assert.equal(
    activeDimensions(filters).at(-1)?.value,
    "Closing within seven days"
  );
});

test("a current Pipeline contract rejects malformed assessments before deriving counts", () => {
  const health = { ...sampleOpportunity.health, status: "Not a status" };
  assert.throws(
    () =>
      decodePipeline({
        today,
        healthScope: "opportunity",
        amountAvailable: true,
        rows: [{ ...sampleOpportunity, health }]
      }),
    /invalid Pipeline data/
  );
});
