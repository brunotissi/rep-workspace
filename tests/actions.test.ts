import assert from "node:assert/strict";
import { test } from "node:test";
import { ApiError } from "../client/api";
import { runAction, withCloseDate } from "../client/actions";
import {
  parseAction,
  performAction,
  recommend,
  recommendations,
  type ActionInput
} from "../server/actions";
import { accountHealth } from "../server/health";
import {
  workspace,
  WorkspaceError,
  type SalesforceWrite
} from "../server/workspace";

const today = "2026-11-21";
const userId = "005000000000001AAA";
const accountId = "001000000000001AAA";
const opportunityId = "006000000000001AAA";
const contactId = "003000000000001AAA";
const roleId = "00K000000000001AAA";
const taskId = "00T000000000001AAA";
const context = { accountId, opportunityId };
const close: Extract<ActionInput, { kind: "closeDate" }> = {
  ...context,
  kind: "closeDate",
  date: "2026-12-01",
  previousDate: "2026-11-20"
};
const task: ActionInput = { ...context, kind: "task", date: "2026-11-22" };
const role: ActionInput = { ...context, kind: "contactRole", contactId };
const json = (records: unknown[]) => Response.json({ records, done: true });
const failure = (status: number, errorCode: string) =>
  Response.json([{ errorCode }], { status });
type Fixture = {
  deniedField?: string;
  pendingTask?: boolean;
  existingRole?: string;
  currentClose?: string;
  relatedOpportunity?: boolean;
  relatedContact?: boolean;
  write?: () => Response | Promise<Response>;
};

function fixture(options: Fixture = {}) {
  const writes: { path: string; change: SalesforceWrite }[] = [];
  const service = workspace(async (path, change) => {
    if (change) {
      writes.push({ path, change });
      return options.write
        ? options.write()
        : change.method === "PATCH"
          ? new Response(null, { status: 204 })
          : Response.json(
              { success: true, id: path.endsWith("/Task") ? taskId : roleId },
              { status: 201 }
            );
    }
    if (path.endsWith("/describe"))
      return Response.json({
        queryable: true,
        createable: true,
        updateable: true,
        fields: [
          "CloseDate",
          "WhatId",
          "Subject",
          "ActivityDate",
          "Status",
          "Priority",
          "OpportunityId",
          "ContactId",
          "Role"
        ].map((name) => ({
          name,
          createable: name !== options.deniedField,
          updateable: name !== options.deniedField,
          picklistValues: [
            { active: true, defaultValue: true, value: "Normal" }
          ]
        }))
      });
    const query = new URL(path, "https://example.com").searchParams.get("q")!;
    if (query.includes("FROM Opportunity WHERE")) {
      assert.match(query, new RegExp("OwnerId = '" + userId));
      assert.match(query, new RegExp("AccountId = '" + accountId));
      return json(
        options.relatedOpportunity === false
          ? []
          : [
              {
                Id: opportunityId,
                CloseDate: options.currentClose ?? close.previousDate
              }
            ]
      );
    }
    if (query.includes("FROM TaskStatus"))
      return json([{ ApiName: "Not Started" }]);
    if (query.includes("FROM Task WHERE"))
      return json(options.pendingTask ? [{ Id: taskId }] : []);
    if (query.includes("FROM Contact WHERE"))
      return json(options.relatedContact === false ? [] : [{ Id: contactId }]);
    if (query.includes("FROM OpportunityContactRole"))
      return json(
        options.existingRole ? [{ Id: roleId, Role: options.existingRole }] : []
      );
    throw new Error("Unexpected fixture read: " + query);
  }, new Map());
  return { service, writes };
}

test("recommendations rank overdue, stale activity, then contact coverage and suppress unknown evidence", () => {
  assert.deepEqual(
    recommend({
      today,
      closeDate: "2026-11-20",
      activity: "stale",
      pendingTask: false,
      decisionMaker: false
    }).map((item) => item.kind),
    ["closeDate", "task", "contactRole"]
  );
  assert.deepEqual(
    recommend({ today, closeDate: today, activity: "none", pendingTask: true }),
    []
  );
  assert.deepEqual(recommend({ today, activity: "stale" }), []);
});

test("recommendation controls reflect describe data and unavailable evidence", async () => {
  const { service } = fixture({ deniedField: "CloseDate", pendingTask: true });
  const result = await recommendations(
    service,
    {
      account: { Id: accountId, Name: "Demo account" },
      today,
      opportunities: {
        data: [
          { Id: opportunityId, Name: "Renewal", CloseDate: close.previousDate }
        ]
      },
      contacts: { data: [{ Id: contactId, Name: "Visible contact" }] },
      tasks: { data: [] },
      events: { data: [] },
      decisionMakerIds: [],
      selectedDecisionMaker: undefined,
      health: {
        data: accountHealth(
          {
            activity: "stale",
            openCount: 1,
            nearestClose: close.previousDate,
            decisionMaker: undefined
          },
          today
        )
      }
    },
    opportunityId
  );
  assert.equal(result.incomplete, true);
  assert.equal(result.pendingTask, true);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0].kind, "closeDate");
  assert.match(result.items[0].unavailable ?? "", /permissions/);
});

test("validation rejects invalid calendar dates, stale dates, unsafe IDs, and missing previous close date", () => {
  assert.deepEqual(parseAction(close, today), close);
  for (const input of [
    { ...task, date: "2027-02-29" },
    { ...task, date: "2026-11-20" },
    { ...role, contactId: "bad' value" },
    { ...close, previousDate: null }
  ])
    assert.throws(() => parseAction(input, today), { status: 400 });
});

test("close-date action writes only the requested field after confirming the selected opportunity belongs to the user", async () => {
  const { service, writes } = fixture();
  assert.match(
    (await performAction(service, userId, close)).message,
    /updated/
  );
  assert.deepEqual(writes, [
    {
      path: "/services/data/v68.0/sobjects/Opportunity/" + opportunityId,
      change: { method: "PATCH", body: { CloseDate: close.date } }
    }
  ]);
});

test("permission, cross-account, and stale-date checks block writes", async () => {
  for (const [options, action, status] of [
    [{ deniedField: "CloseDate" }, close, 403],
    [{ relatedOpportunity: false }, close, 404],
    [{ currentClose: "2026-11-18" }, close, 409],
    [{ relatedContact: false }, role, 400],
    [{ deniedField: "Role" }, role, 403],
    [{ deniedField: "WhatId" }, task, 403]
  ] as const) {
    const { service, writes } = fixture(options);
    await assert.rejects(performAction(service, userId, action), { status });
    assert.equal(writes.length, 0);
  }
});

test("creates an account-linked open Task and blocks an existing follow-up", async () => {
  const { service, writes } = fixture();
  await performAction(service, userId, task);
  assert.deepEqual(writes[0], {
    path: "/services/data/v68.0/sobjects/Task",
    change: {
      method: "POST",
      body: {
        WhatId: accountId,
        Subject: "Rep Workspace follow-up",
        ActivityDate: task.date,
        Status: "Not Started",
        Priority: "Normal"
      }
    }
  });
  const duplicate = fixture({ pendingTask: true });
  await assert.rejects(performAction(duplicate.service, userId, task), {
    status: 409
  });
  assert.equal(duplicate.writes.length, 0);
});

test("role action creates, updates, or leaves an already-correct record alone", async () => {
  const insert = fixture();
  await performAction(insert.service, userId, role);
  assert.deepEqual(insert.writes[0].change, {
    method: "POST",
    body: {
      OpportunityId: opportunityId,
      ContactId: contactId,
      Role: "Decision Maker"
    }
  });
  const update = fixture({ existingRole: "Evaluator" });
  await performAction(update.service, userId, role);
  assert.equal(
    update.writes[0].path,
    "/services/data/v68.0/sobjects/OpportunityContactRole/" + roleId
  );
  assert.deepEqual(update.writes[0].change, {
    method: "PATCH",
    body: { Role: "Decision Maker" }
  });
  const unchanged = fixture({ existingRole: "Decision Maker" });
  await performAction(unchanged.service, userId, role);
  assert.equal(unchanged.writes.length, 0);
});

test("concurrent duplicate submit does not reach Salesforce", async () => {
  let finish!: (response: Response) => void;
  const hold = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  const { service, writes } = fixture({ write: () => hold });
  const first = performAction(service, userId, task);
  await assert.rejects(performAction(service, userId, task), { status: 409 });
  finish(Response.json({ success: true, id: taskId }, { status: 201 }));
  await first;
  assert.equal(writes.length, 1);
});

test("Salesforce validation, lock, quota, permission, expired session, and unknown outcome are distinct", async () => {
  for (const [response, expected, uncertain] of [
    [failure(400, "FIELD_CUSTOM_VALIDATION_EXCEPTION"), 422, false],
    [failure(400, "UNABLE_TO_LOCK_ROW"), 409, false],
    [failure(403, "REQUEST_LIMIT_EXCEEDED"), 429, false],
    [failure(400, "INSUFFICIENT_ACCESS_OR_READONLY"), 403, false],
    [failure(401, "INVALID_SESSION_ID"), 401, false],
    [failure(500, "UNKNOWN_EXCEPTION"), 502, true]
  ] as const) {
    const { service } = fixture({ write: () => response });
    await assert.rejects(
      performAction(service, userId, close),
      (error: unknown) =>
        error instanceof WorkspaceError &&
        error.status === expected &&
        error.uncertain === uncertain
    );
  }
});

test("client previews close date, rolls back rejection, and refreshes after success or an uncertain write", async () => {
  const previous = [{ Id: opportunityId, CloseDate: close.previousDate }];
  for (const [error, expected] of [
    [new ApiError(422, "Rejected"), ["preview", "reject", "rollback"]],
    [
      new ApiError(502, "Unknown", true),
      ["preview", "reject", "refresh", "rollback"]
    ],
    [undefined, ["preview", "confirm", "refresh", "rollback"]]
  ] as const) {
    const calls: string[] = [];
    let cached = previous;
    let displayed = previous;
    await runAction(
      close,
      {
        preview: (action) => {
          displayed = withCloseDate(cached, action);
          calls.push(action ? "preview" : "rollback");
        },
        confirm: () => {
          cached = withCloseDate(cached, close);
          calls.push("confirm");
        },
        reject: () => calls.push("reject"),
        refresh: () => calls.push("refresh")
      },
      async () => {
        assert.equal(displayed[0].CloseDate, close.date);
        if (error) throw error;
        return { message: "Saved" };
      }
    );
    assert.deepEqual(calls, expected);
    assert.equal(
      displayed[0].CloseDate,
      error ? close.previousDate : close.date
    );
  }
});
