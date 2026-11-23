import { accountActivityDays } from "./calendar";
import { accountHealth } from "./health";
import { opportunityHealth } from "./opportunity-health";

const api = "/services/data/v68.0";
export type SalesforceWrite = {
  method: "POST" | "PATCH";
  body: Record<string, string>;
};
type RequestSalesforce = (
  path: string,
  write?: SalesforceWrite
) => Promise<Response>;
type Field = {
  name: string;
  createable?: boolean;
  updateable?: boolean;
  picklistValues?: { value: string; active: boolean; defaultValue: boolean }[];
};
type Describe = {
  queryable: boolean;
  createable?: boolean;
  updateable?: boolean;
  fields: Field[];
};
export type DescribeCache = Map<
  string,
  { expires: number; value: Promise<Describe> }
>;
type Opportunity = {
  Id: string;
  Name: string;
  AccountId?: string;
  StageName?: string;
  CloseDate?: string;
  Amount?: number | null;
  formattedAmount?: string | null;
};
type Account = { Id: string; Name: string; Owner?: { Name: string } };
type Activity = {
  Id: string;
  Subject?: string;
  ActivityDate?: string;
  ActivityDateTime?: string;
};
type Contact = { Id: string; Name: string; Title?: string };
type PipelineEvidence = {
  AccountId: string;
  openCount: number;
  nearestClose?: string;
};
type ActivityEvidence = { AccountId: string };
type RoleEvidence = {
  Opportunity?: { AccountId: string };
  ContactId?: string;
  OpportunityId?: string;
  IsPrimary?: boolean;
};
const soqlTime = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

type ReadDiagnostic = { httpStatus: number; code?: string; field?: string };
const taskLookupFields = ["Id", "WhatId", "IsClosed", "Subject"];
const safeQueryCodes = new Set([
  "INVALID_FIELD",
  "INVALID_TYPE",
  "MALFORMED_QUERY",
  "INVALID_QUERY_FILTER_OPERATOR",
  "INSUFFICIENT_ACCESS_OR_READONLY",
  "REQUEST_LIMIT_EXCEEDED"
]);

export class WorkspaceError extends Error {
  constructor(
    readonly status: number,
    message: string,
    readonly uncertain = false,
    readonly readDiagnostic?: ReadDiagnostic
  ) {
    super(message);
  }
}

export function recordId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^[a-zA-Z0-9]{15}(?:[a-zA-Z0-9]{3})?$/.test(value)
  );
}

function section<T>(
  result: PromiseSettledResult<T>
): { data: T } | { error: string } {
  if (result.status === "fulfilled") return { data: result.value };
  if (result.reason instanceof WorkspaceError) {
    if (result.reason.status === 401) throw result.reason;
    return { error: result.reason.message };
  }
  return { error: "Salesforce data is temporarily unavailable." };
}

function chunks<T>(items: T[], size: number) {
  const batches: T[][] = [];
  for (let index = 0; index < items.length; index += size)
    batches.push(items.slice(index, index + size));
  return batches;
}

export function workspace(
  request: RequestSalesforce,
  fieldCache: DescribeCache
) {
  async function get<T>(path: string): Promise<T> {
    const response = await request(path);
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      const upstream = Array.isArray(data)
        ? data.find((item) => safeQueryCodes.has(item?.errorCode))
        : undefined;
      const field =
        typeof upstream?.message === "string"
          ? upstream.message.match(
              /(?:no such column|field)\s+['"](\w+)['"]/i
            )?.[1]
          : undefined;
      const diagnostic = {
        httpStatus: response.status,
        code: upstream?.errorCode,
        field: taskLookupFields.find(
          (name) => name.toLowerCase() === field?.toLowerCase()
        )
      };
      const failure = (status: number, message: string) =>
        new WorkspaceError(status, message, false, diagnostic);
      if (response.status === 401)
        throw failure(401, "Your Salesforce session expired. Sign in again.");
      if (
        response.status === 429 ||
        (Array.isArray(data) &&
          data.some((item) => item?.errorCode === "REQUEST_LIMIT_EXCEEDED"))
      ) {
        throw failure(
          429,
          "The Salesforce API limit was reached. Try again later."
        );
      }
      if (
        response.status === 403 ||
        (Array.isArray(data) &&
          data.some((item) =>
            [
              "INVALID_FIELD",
              "INVALID_TYPE",
              "INSUFFICIENT_ACCESS_OR_READONLY"
            ].includes(item?.errorCode)
          ))
      ) {
        throw failure(
          403,
          "This information is unavailable with your Salesforce permissions."
        );
      }
      throw failure(502, "Salesforce could not load this information.");
    }
    if (!data)
      throw new WorkspaceError(
        502,
        "Salesforce returned an unreadable response."
      );
    return data as T;
  }

  async function query<T>(soql: string) {
    let path: string | undefined =
      api + "/query?" + new URLSearchParams({ q: soql });
    const records: T[] = [];
    const visited = new Set<string>();
    while (path) {
      if (visited.has(path))
        throw new WorkspaceError(
          502,
          "Salesforce pagination could not continue."
        );
      visited.add(path);
      const page: { records: T[]; done: boolean; nextRecordsUrl?: string } =
        await get(path);
      if (!Array.isArray(page.records) || typeof page.done !== "boolean")
        throw new WorkspaceError(
          502,
          "Salesforce returned an unreadable query response."
        );
      records.push(...page.records);
      path = page.done ? undefined : page.nextRecordsUrl;
      if (!page.done && !path?.startsWith(api + "/query/"))
        throw new WorkspaceError(
          502,
          "Salesforce pagination could not continue."
        );
    }
    return records;
  }

  function describe(object: string) {
    const cached = fieldCache.get(object);
    const now = Date.now();
    if (cached && cached.expires > now) return cached.value;
    const value = get<Describe>(
      api + "/sobjects/" + object + "/describe"
    ).catch((error) => {
      if (fieldCache.get(object)?.value === value) fieldCache.delete(object);
      throw error;
    });
    fieldCache.set(object, { expires: now + 60_000, value });
    return value;
  }

  async function fields(object: string) {
    const metadata = await describe(object);
    if (!metadata.queryable)
      throw new WorkspaceError(
        403,
        "This object is unavailable with your Salesforce permissions."
      );
    return new Set(metadata.fields.map((field) => field.name));
  }

  async function write(object: string, change: SalesforceWrite, id?: string) {
    const path = api + "/sobjects/" + object + (id ? "/" + id : "");
    const unknownOutcome = () =>
      new WorkspaceError(
        502,
        "Salesforce did not confirm the save. Check the refreshed record before trying again.",
        true
      );
    const response = await request(path, change).catch((error) => {
      if (error instanceof WorkspaceError) throw error;
      throw unknownOutcome();
    });
    if (response.status === 204 && change.method === "PATCH") return;
    const data = await response.json().catch(() => null);
    if (
      response.ok &&
      change.method === "POST" &&
      data?.success === true &&
      recordId(data.id)
    )
      return;
    const codes: string[] = Array.isArray(data)
      ? data.map((item) => item.errorCode)
      : [];
    if (response.status === 401)
      throw new WorkspaceError(
        401,
        "Your Salesforce session expired. Sign in again."
      );
    if (response.status === 429 || codes.includes("REQUEST_LIMIT_EXCEEDED"))
      throw new WorkspaceError(
        429,
        "The Salesforce API limit was reached. Try again later."
      );
    if (
      codes.some((code) =>
        ["UNABLE_TO_LOCK_ROW", "ENTITY_IS_LOCKED"].includes(code)
      )
    )
      throw new WorkspaceError(
        409,
        "Salesforce has locked this record. Try again after it is unlocked."
      );
    if (
      response.status === 403 ||
      codes.some((code) =>
        [
          "INSUFFICIENT_ACCESS_OR_READONLY",
          "INSUFFICIENT_ACCESS_ON_CROSS_REFERENCE_ENTITY",
          "INVALID_FIELD_FOR_INSERT_UPDATE",
          "INVALID_TYPE",
          "OP_WITH_INVALID_USER_TYPE_EXCEPTION"
        ].includes(code)
      )
    )
      throw new WorkspaceError(
        403,
        "Salesforce denied permission to save this change."
      );
    if (response.status === 404)
      throw new WorkspaceError(
        404,
        "The Salesforce record is no longer available."
      );
    if (response.ok || response.status >= 500) throw unknownOutcome();
    throw new WorkspaceError(
      422,
      "Salesforce rejected the change. Check the values and your org's validation rules."
    );
  }

  async function opportunities(where: string) {
    const available = await fields("Opportunity");
    const names = [
      "Id",
      "Name",
      ...["AccountId", "StageName", "CloseDate", "Amount"].filter((name) =>
        available.has(name)
      )
    ];
    if (available.has("Amount")) names.push("FORMAT(Amount) formattedAmount");
    return query<Opportunity>(
      "SELECT " +
        names.join(", ") +
        " FROM Opportunity WHERE IsClosed = false AND " +
        where +
        " ORDER BY Id"
    );
  }

  async function requireOpenOpportunity(
    userId: string,
    accountId: string,
    opportunityId?: string,
    includeCloseDate = false
  ) {
    if (
      !recordId(userId) ||
      !recordId(accountId) ||
      (opportunityId !== undefined && !recordId(opportunityId))
    )
      throw new WorkspaceError(400, "Invalid opportunity context.");
    const [opportunity] = await query<{ Id: string; CloseDate?: string }>(
      "SELECT Id" +
        (includeCloseDate ? ", CloseDate" : "") +
        " FROM Opportunity WHERE AccountId = '" +
        accountId +
        "' AND OwnerId = '" +
        userId +
        "' AND IsClosed = false" +
        (opportunityId ? " AND Id = '" + opportunityId + "'" : "") +
        " LIMIT 1"
    );
    if (!opportunity)
      throw new WorkspaceError(
        404,
        "The selected account or opportunity is unavailable in your pipeline."
      );
    return opportunity;
  }

  async function accountRecords(where: string) {
    const available = await fields("Account");
    return query<Account>(
      "SELECT Id, Name" +
        (available.has("OwnerId") ? ", Owner.Name" : "") +
        " FROM Account WHERE " +
        where
    );
  }

  async function evidence(ids: string[], today: string) {
    const health = new Map<string, ReturnType<typeof accountHealth>>();
    const cutoff = new Date(
      Date.parse(today) - accountActivityDays * 86_400_000
    )
      .toISOString()
      .slice(0, 10);
    const accountSet = (batch: string[]) =>
      "(" + batch.map((id) => "'" + id + "'").join(",") + ")";
    async function activityAccounts(batch: string[], recency: string) {
      const append =
        " AND ActivityDate " +
        recency +
        " AND AccountId IN " +
        accountSet(batch) +
        " GROUP BY AccountId";
      const checks = await Promise.allSettled([
        query<ActivityEvidence>(
          "SELECT AccountId, COUNT(Id) activityCount FROM Task WHERE IsClosed = true AND ActivityDate <= " +
            today +
            append
        ),
        query<ActivityEvidence>(
          "SELECT AccountId, COUNT(Id) activityCount FROM Event WHERE EndDateTime <= " +
            soqlTime() +
            append
        )
      ]);
      const results = checks.map(section);
      return {
        accounts: new Set(
          results.flatMap((result) =>
            "data" in result ? result.data.map((row) => row.AccountId) : []
          )
        ),
        complete: results.every((result) => "data" in result)
      };
    }
    for (const batch of chunks(ids, 100)) {
      const scope = accountSet(batch);
      const results = await Promise.allSettled([
        fields("Opportunity").then((available) =>
          query<PipelineEvidence>(
            "SELECT AccountId, COUNT(Id) openCount" +
              (available.has("CloseDate")
                ? ", MIN(CloseDate) nearestClose"
                : "") +
              " FROM Opportunity WHERE IsClosed = false AND AccountId IN " +
              scope +
              " GROUP BY AccountId"
          ).then((rows) => ({ rows, hasClose: available.has("CloseDate") }))
        ),
        query<RoleEvidence>(
          "SELECT Opportunity.AccountId FROM OpportunityContactRole WHERE Role = 'Decision Maker'" +
            " AND Opportunity.IsClosed = false AND Opportunity.AccountId IN " +
            scope
        ),
        activityAccounts(batch, "> " + cutoff)
      ]);
      const [pipelineResult, roleResult, recentResult] = results;
      const pipeline = section(pipelineResult);
      const roles = section(roleResult);
      const recent = section(recentResult);
      const recentData = "data" in recent ? recent.data : undefined;
      const olderIds = recentData?.complete
        ? batch.filter((id) => !recentData.accounts.has(id))
        : [];
      const older = olderIds.length
        ? await activityAccounts(olderIds, "<= " + cutoff)
        : undefined;
      const indexed =
        "data" in pipeline
          ? new Map(pipeline.data.rows.map((row) => [row.AccountId, row]))
          : undefined;
      const covered =
        "data" in roles
          ? new Set(roles.data.map((row) => row.Opportunity?.AccountId))
          : undefined;
      for (const id of batch) {
        const open = indexed?.get(id);
        const activity = recentData?.accounts.has(id)
          ? "recent"
          : older?.accounts.has(id)
            ? "stale"
            : older?.complete
              ? "none"
              : undefined;
        health.set(
          id,
          accountHealth(
            {
              openCount: indexed ? (open?.openCount ?? 0) : undefined,
              nearestClose:
                "data" in pipeline && pipeline.data.hasClose
                  ? (open?.nearestClose ?? null)
                  : undefined,
              activity,
              decisionMaker: covered?.has(id)
            },
            today
          )
        );
      }
    }
    return health;
  }

  async function opportunityCoverage(ids: string[]) {
    const coverage = new Map<string, boolean>();
    for (const window of chunks(chunks(ids, 175), 3)) {
      const results = await Promise.allSettled(
        window.map(async (batch) => {
          const scope = batch.map((id) => "'" + id + "'").join(",");
          const roles = await query<{ OpportunityId: string }>(
            "SELECT OpportunityId FROM OpportunityContactRole WHERE Role = 'Decision Maker'" +
              " AND OpportunityId IN (" +
              scope +
              ") GROUP BY OpportunityId"
          );
          if (!roles.every((role) => recordId(role?.OpportunityId)))
            throw new WorkspaceError(
              502,
              "Salesforce returned unreadable role evidence."
            );
          const covered = new Set(roles.map((role) => role.OpportunityId));
          for (const id of batch) coverage.set(id, covered.has(id));
        })
      );
      const failures = results.flatMap((result) =>
        result.status === "rejected" && result.reason instanceof WorkspaceError
          ? [result.reason]
          : []
      );
      const expired = failures.find((error) => error.status === 401);
      if (expired) throw expired;
      if (
        failures.some((error) => error.status === 429 || error.status === 403)
      )
        break;
    }
    return coverage;
  }

  async function pipeline(userId: string, today: string) {
    const amountAvailable = (await fields("Opportunity")).has("Amount");
    const rows = await opportunities("OwnerId = '" + userId + "'");
    const ids = [...new Set(rows.map((row) => row.AccountId).filter(recordId))];
    const names = new Map<string, string>();
    const [coverage, namesResult] = await Promise.all([
      opportunityCoverage(rows.map((row) => row.Id).filter(recordId)),
      (async () => {
        for (const batch of chunks(ids, 100)) {
          const scope = batch.map((id) => "'" + id + "'").join(",");
          for (const account of await accountRecords("Id IN (" + scope + ")"))
            names.set(account.Id, account.Name);
        }
      })().then(
        () => null,
        (error) => error
      )
    ]);
    if (namesResult instanceof WorkspaceError && namesResult.status === 401)
      throw namesResult;
    return {
      today,
      amountAvailable,
      healthScope: "opportunity" as const,
      accountWarning: namesResult
        ? "Some Salesforce account names could not be loaded."
        : undefined,
      rows: rows.map((row) => ({
        ...row,
        accountName: row.AccountId ? names.get(row.AccountId) : undefined,
        health: opportunityHealth(row.CloseDate, coverage.get(row.Id), today)
      }))
    };
  }

  async function snapshot(
    id: string,
    today: string,
    selectedOpportunityId?: string
  ) {
    const match = "'" + id + "'";
    const [account] = await accountRecords("Id = " + match);
    if (!account) throw new WorkspaceError(404, "This account is unavailable.");

    const [open, contacts, tasks, events, health, decisionMakers] =
      await Promise.allSettled([
        opportunities("AccountId = " + match),
        fields("Contact").then((available) =>
          query<Contact>(
            "SELECT Id, Name" +
              (available.has("Title") ? ", Title" : "") +
              " FROM Contact WHERE AccountId = " +
              match +
              " ORDER BY Name, Id LIMIT 10"
          )
        ),
        fields("Task").then(async (available) => {
          const dateReadable = available.has("ActivityDate");
          const columns = [
            "Id",
            ...["Subject", "ActivityDate"].filter((name) => available.has(name))
          ];
          const rows = await query<Activity>(
            "SELECT " +
              columns.join(", ") +
              " FROM Task WHERE AccountId = " +
              match +
              " AND IsClosed = true" +
              (dateReadable
                ? " AND ActivityDate <= " +
                  today +
                  " ORDER BY ActivityDate DESC, Id LIMIT 10"
                : " ORDER BY Id LIMIT 10")
          );
          return { rows, dateReadable };
        }),
        query<Activity>(
          "SELECT Id, Subject, ActivityDateTime FROM Event WHERE AccountId = " +
            match +
            " AND EndDateTime <= " +
            soqlTime() +
            " ORDER BY ActivityDateTime DESC, Id LIMIT 10"
        ),
        evidence([id], today).then((result) => result.get(id)!),
        query<RoleEvidence>(
          "SELECT ContactId, OpportunityId FROM OpportunityContactRole WHERE Role = 'Decision Maker'" +
            " AND Opportunity.IsClosed = false AND Opportunity.AccountId = " +
            match
        )
      ]);
    const roles = section(decisionMakers);
    const taskResult = section(tasks);
    const taskSection:
      { data: Activity[]; datesUnavailable?: boolean } | { error: string } =
      "data" in taskResult
        ? {
            data: taskResult.data.rows,
            datesUnavailable: !taskResult.data.dateReadable
          }
        : taskResult;
    return {
      account,
      today,
      opportunities: section(open),
      contacts: section(contacts),
      tasks: taskSection,
      events: section(events),
      health: section(health),
      selectedDecisionMaker:
        selectedOpportunityId && "data" in roles
          ? roles.data.some(
              (role) => role.OpportunityId === selectedOpportunityId
            )
          : undefined,
      selectedDecisionMakerIds:
        selectedOpportunityId && "data" in roles
          ? [
              ...new Set(
                roles.data
                  .filter(
                    (role) => role.OpportunityId === selectedOpportunityId
                  )
                  .map((role) => role.ContactId)
                  .filter(recordId)
              )
            ]
          : undefined,
      decisionMakerIds:
        "data" in roles
          ? [
              ...new Set(
                roles.data.map((role) => role.ContactId).filter(recordId)
              )
            ]
          : []
    };
  }
  return {
    get,
    query,
    describe,
    write,
    pipeline,
    snapshot,
    requireOpenOpportunity
  };
}
