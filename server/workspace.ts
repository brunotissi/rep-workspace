import { accountHealth } from "./health";

const api = "/services/data/v68.0";
type RequestSalesforce = (path: string) => Promise<Response>;
type Field = { name: string };
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
  IsPrimary?: boolean;
};
const soqlTime = () => new Date().toISOString().replace(/\.\d{3}Z$/, "Z");

export class WorkspaceError extends Error {
  constructor(
    readonly status: number,
    message: string
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
  fieldCache: Map<string, Promise<Set<string>>>
) {
  async function get<T>(path: string): Promise<T> {
    const response = await request(path);
    const data = await response.json().catch(() => null);
    if (!response.ok) {
      if (response.status === 401)
        throw new WorkspaceError(
          401,
          "Your Salesforce session expired. Sign in again."
        );
      if (
        response.status === 429 ||
        (Array.isArray(data) &&
          data.some((item) => item.errorCode === "REQUEST_LIMIT_EXCEEDED"))
      ) {
        throw new WorkspaceError(
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
            ].includes(item.errorCode)
          ))
      ) {
        throw new WorkspaceError(
          403,
          "This information is unavailable with your Salesforce permissions."
        );
      }
      throw new WorkspaceError(
        502,
        "Salesforce could not load this information."
      );
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
    while (path) {
      const page: { records: T[]; done: boolean; nextRecordsUrl?: string } =
        await get(path);
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

  function fields(object: string) {
    let cached = fieldCache.get(object);
    if (!cached) {
      cached = get<{ queryable: boolean; fields: Field[] }>(
        api + "/sobjects/" + object + "/describe"
      )
        .then((describe) => {
          if (!describe.queryable)
            throw new WorkspaceError(
              403,
              "This object is unavailable with your Salesforce permissions."
            );
          return new Set(describe.fields.map((field) => field.name));
        })
        .catch((error) => {
          fieldCache.delete(object);
          throw error;
        });
      fieldCache.set(object, cached);
    }
    return cached;
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
    const cutoff = new Date(Date.parse(today) - 21 * 86_400_000)
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

  async function pipeline(userId: string, today: string) {
    const rows = await opportunities("OwnerId = '" + userId + "'");
    const ids = [...new Set(rows.map((row) => row.AccountId).filter(recordId))];
    const names = new Map<string, string>();
    const [health, namesResult] = await Promise.all([
      evidence(ids, today),
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
      accountWarning: namesResult
        ? "Some Salesforce account names could not be loaded."
        : undefined,
      rows: rows.map((row) => ({
        ...row,
        accountName: row.AccountId ? names.get(row.AccountId) : undefined,
        health:
          row.AccountId && names.has(row.AccountId)
            ? health.get(row.AccountId)
            : undefined
      }))
    };
  }

  async function snapshot(id: string, today: string) {
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
        query<Activity>(
          "SELECT Id, Subject, ActivityDate FROM Task WHERE AccountId = " +
            match +
            " AND IsClosed = true AND ActivityDate <= " +
            today +
            " ORDER BY ActivityDate DESC, Id LIMIT 10"
        ),
        query<Activity>(
          "SELECT Id, Subject, ActivityDateTime FROM Event WHERE AccountId = " +
            match +
            " AND EndDateTime <= " +
            soqlTime() +
            " ORDER BY ActivityDateTime DESC, Id LIMIT 10"
        ),
        evidence([id], today).then((result) => result.get(id)!),
        query<RoleEvidence>(
          "SELECT ContactId FROM OpportunityContactRole WHERE Role = 'Decision Maker'" +
            " AND Opportunity.IsClosed = false AND Opportunity.AccountId = " +
            match
        )
      ]);
    const roles = section(decisionMakers);
    return {
      account,
      today,
      opportunities: section(open),
      contacts: section(contacts),
      tasks: section(tasks),
      events: section(events),
      health: section(health),
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
  return { get, pipeline, snapshot };
}
