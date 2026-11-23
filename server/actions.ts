import { calendarDay } from "./calendar";
import { recordId, WorkspaceError, type workspace } from "./workspace";
import type { Health } from "./health";

type Service = ReturnType<typeof workspace>;
type Snapshot = Awaited<ReturnType<Service["snapshot"]>>;
type Kind = "task" | "closeDate" | "contactRole";
type Context = { accountId: string; opportunityId: string };
export type ActionInput = Context &
  (
    | { kind: "task"; date: string }
    | { kind: "closeDate"; date: string; previousDate: string }
    | { kind: "contactRole"; contactId: string }
  );
type Candidate = { kind: Kind; title: string; reason: string };
export type Recommendation = Candidate & {
  unavailable?: string;
  eligibleContactIds?: string[];
};
const followUp = "Rep Workspace follow-up";
const decisionMaker = "Decision Maker";
const taskFields = ["WhatId", "Subject", "ActivityDate", "Status", "Priority"];
const roleFields = ["OpportunityId", "ContactId", "Role"];

export function recommend(evidence: {
  closeDate?: string;
  today: string;
  activity?: Health["activity"];
  pendingTask?: boolean;
  decisionMaker?: boolean;
}): Candidate[] {
  const results: Candidate[] = [];
  if (calendarDay(evidence.closeDate) < calendarDay(evidence.today))
    results.push({
      kind: "closeDate",
      title: "Update the close date",
      reason: "The selected opportunity is overdue."
    });
  if (
    evidence.pendingTask === false &&
    (evidence.activity === "stale" || evidence.activity === "none")
  )
    results.push({
      kind: "task",
      title: "Create a follow-up task",
      reason:
        evidence.activity === "stale"
          ? "The account's last visible activity was at least 21 days ago."
          : "No completed task or past event is visible for this account."
    });
  if (evidence.decisionMaker === false)
    results.push({
      kind: "contactRole",
      title: "Identify a decision maker",
      reason: "This opportunity has no visible Decision Maker contact role."
    });
  return results;
}

function dateOnly(value: unknown): value is string {
  return Number.isFinite(calendarDay(value));
}

export function parseAction(input: unknown, today: string): ActionInput {
  if (!input || typeof input !== "object")
    throw new WorkspaceError(400, "Invalid action.");
  const { accountId, opportunityId, kind, date, previousDate, contactId } =
    input as Record<string, unknown>;
  if (!recordId(accountId) || !recordId(opportunityId))
    throw new WorkspaceError(400, "Select a valid account and opportunity.");
  const context = { accountId, opportunityId };
  if (kind === "contactRole" && recordId(contactId))
    return { ...context, kind, contactId };
  if (kind === "task" || kind === "closeDate") {
    if (!dateOnly(date) || date < today || date > "2099-12-31")
      throw new WorkspaceError(
        400,
        "Enter a valid date between today and 2099-12-31."
      );
    if (kind === "task") return { ...context, kind, date };
    if (dateOnly(previousDate)) return { ...context, kind, date, previousDate };
  }
  throw new WorkspaceError(
    400,
    "The action is missing a valid date or contact."
  );
}

async function can(
  service: Service,
  object: string,
  operation: "createable" | "updateable",
  fields: string[]
) {
  const metadata = await service.describe(object);
  return (
    metadata[operation] === true &&
    fields.every((name) =>
      metadata.fields.some(
        (field) => field.name === name && field[operation] === true
      )
    )
  );
}

async function existingTask(service: Service, accountId: string) {
  const rows = await service.query<{ Id: string }>(
    "SELECT Id FROM Task WHERE WhatId = '" +
      accountId +
      "' AND IsClosed = false AND Subject = '" +
      followUp +
      "' LIMIT 1"
  );
  return rows.length > 0;
}

async function optional<T>(read: Promise<T>) {
  return read.catch((error) => {
    if (error instanceof WorkspaceError && error.status === 401) throw error;
    return undefined;
  });
}

export async function recommendations(
  service: Service,
  snapshot: Snapshot,
  selectedId: string
) {
  const opportunity =
    "data" in snapshot.opportunities
      ? snapshot.opportunities.data.find((row) => row.Id === selectedId)
      : undefined;
  if (!opportunity) return { items: [], incomplete: true, pendingTask: false };
  const activity =
    "data" in snapshot.health ? snapshot.health.data.activity : undefined;
  let pendingTask: boolean | undefined;
  let lookupFailure:
    | {
        error?: WorkspaceError["readDiagnostic"];
        taskFieldsMissingFromDescribe?: string[];
      }
    | undefined;
  if (activity === "stale" || activity === "none") {
    try {
      pendingTask = await existingTask(service, snapshot.account.Id);
    } catch (error) {
      if (error instanceof WorkspaceError && error.status === 401) throw error;
      const describe = await optional(service.describe("Task"));
      lookupFailure = {
        error:
          error instanceof WorkspaceError ? error.readDiagnostic : undefined,
        taskFieldsMissingFromDescribe: describe
          ? ["Id", "WhatId", "IsClosed", "Subject"].filter(
              (name) => !describe.fields.some((field) => field.name === name)
            )
          : undefined
      };
    }
  }
  const candidates = recommend({
    closeDate: opportunity.CloseDate,
    today: snapshot.today,
    activity,
    pendingTask,
    decisionMaker: snapshot.selectedDecisionMaker
  });
  const items: Recommendation[] = await Promise.all(
    candidates.map(async (candidate) => {
      let allowed: boolean | undefined;
      let unavailable: string | undefined;
      let eligibleContactIds: string[] | undefined;
      switch (candidate.kind) {
        case "closeDate":
          allowed = await optional(
            can(service, "Opportunity", "updateable", ["CloseDate"])
          );
          break;
        case "task":
          allowed = await optional(
            can(service, "Task", "createable", taskFields)
          );
          break;
        case "contactRole": {
          const [create, update] = await Promise.all([
            optional(
              can(service, "OpportunityContactRole", "createable", roleFields)
            ),
            optional(
              can(service, "OpportunityContactRole", "updateable", ["Role"])
            )
          ]);
          allowed =
            create === true || update === true
              ? true
              : create === false && update === false
                ? false
                : undefined;
          if ("error" in snapshot.contacts || !snapshot.contacts.data.length)
            unavailable = "No eligible contacts are available on this account.";
          else if (allowed) {
            const existing = await optional(
              service.query<{ ContactId: string }>(
                "SELECT ContactId FROM OpportunityContactRole WHERE OpportunityId = '" +
                  selectedId +
                  "'"
              )
            );
            if (!existing)
              unavailable = "Existing contact roles could not be checked.";
            else {
              const assigned = new Set(existing.map((row) => row.ContactId));
              eligibleContactIds = snapshot.contacts.data
                .filter((contact) =>
                  assigned.has(contact.Id) ? update === true : create === true
                )
                .map((contact) => contact.Id);
              if (!eligibleContactIds.length)
                unavailable =
                  "Your Salesforce permissions do not allow a role change for the displayed contacts.";
            }
          }
          break;
        }
      }
      return {
        ...candidate,
        eligibleContactIds,
        unavailable:
          unavailable ??
          (allowed === true
            ? undefined
            : allowed === false
              ? "Your Salesforce permissions do not allow this action."
              : "The app could not verify your Salesforce permissions.")
      };
    })
  );
  return {
    items,
    pendingTask: pendingTask === true,
    followUp: {
      activity: activity ?? "unknown",
      lookup: lookupFailure
        ? ("failed" as const)
        : pendingTask === true
          ? ("found" as const)
          : pendingTask === false
            ? ("empty" as const)
            : ("skipped" as const),
      ...lookupFailure
    },
    incomplete:
      !opportunity.CloseDate ||
      activity === undefined ||
      snapshot.selectedDecisionMaker === undefined ||
      ((activity === "stale" || activity === "none") &&
        pendingTask === undefined)
  };
}

const writing = new Set<string>();

export async function performAction(
  service: Service,
  userId: string,
  action: ActionInput
) {
  const { accountId, opportunityId, kind } = action;
  const target = kind === "task" ? accountId : opportunityId;
  const key = [kind, target].join(":");
  if (writing.has(key))
    throw new WorkspaceError(409, "This action is already in progress.");
  writing.add(key);
  try {
    const requirePermission = async (
      object: string,
      operation: "createable" | "updateable",
      fields: string[]
    ) => {
      if (!(await can(service, object, operation, fields)))
        throw new WorkspaceError(
          403,
          "Your Salesforce permissions do not allow this action."
        );
    };
    if (kind === "task")
      await requirePermission("Task", "createable", taskFields);
    if (kind === "closeDate")
      await requirePermission("Opportunity", "updateable", ["CloseDate"]);

    const opportunity = await service.requireOpenOpportunity(
      userId,
      accountId,
      opportunityId,
      kind === "closeDate"
    );

    if (kind === "closeDate") {
      if (opportunity.CloseDate === action.date)
        return { message: "Close date is already saved." };
      if (!opportunity.CloseDate)
        throw new WorkspaceError(403, "The current close date is unavailable.");
      if (opportunity.CloseDate !== action.previousDate)
        throw new WorkspaceError(
          409,
          "The close date changed in Salesforce. Review the refreshed date."
        );
      await service.write(
        "Opportunity",
        { method: "PATCH", body: { CloseDate: action.date } },
        opportunityId
      );
      return { message: "Close date updated in Salesforce." };
    }

    if (kind === "task") {
      if (await existingTask(service, accountId))
        throw new WorkspaceError(
          409,
          "There is already an open workspace follow-up for this account."
        );
      const [metadata, statuses] = await Promise.all([
        service.describe("Task"),
        service.query<{ ApiName: string }>(
          "SELECT ApiName FROM TaskStatus WHERE IsClosed = false ORDER BY SortOrder LIMIT 1"
        )
      ]);
      const priorities = metadata.fields
        .find((field) => field.name === "Priority")
        ?.picklistValues?.filter((value) => value.active);
      const priority =
        priorities?.find((value) => value.defaultValue)?.value ??
        priorities?.[0]?.value;
      if (!statuses[0]?.ApiName || !priority)
        throw new WorkspaceError(
          422,
          "Salesforce has no usable open task status or priority."
        );
      await service.write("Task", {
        method: "POST",
        body: {
          WhatId: accountId,
          Subject: followUp,
          ActivityDate: action.date,
          Status: statuses[0].ApiName,
          Priority: priority
        }
      });
      return { message: "Follow-up task created in Salesforce." };
    }

    const { contactId } = action;
    const [contact] = await service.query<{ Id: string }>(
      "SELECT Id FROM Contact WHERE Id = '" +
        contactId +
        "' AND AccountId = '" +
        accountId +
        "' LIMIT 1"
    );
    if (!contact)
      throw new WorkspaceError(
        400,
        "Select a visible contact from this account."
      );
    const existing = await service.query<{ Id: string; Role: string }>(
      "SELECT Id, Role FROM OpportunityContactRole WHERE OpportunityId = '" +
        opportunityId +
        "' AND ContactId = '" +
        contactId +
        "' LIMIT 2"
    );
    if (existing.length > 1)
      throw new WorkspaceError(
        409,
        "Salesforce returned conflicting contact roles. Review them before changing this role."
      );
    if (existing[0]?.Role === decisionMaker)
      return { message: "This contact is already a decision maker." };
    if (existing.length) {
      await requirePermission("OpportunityContactRole", "updateable", ["Role"]);
      await service.write(
        "OpportunityContactRole",
        { method: "PATCH", body: { Role: decisionMaker } },
        existing[0].Id
      );
      return { message: "Contact role updated in Salesforce." };
    }
    await requirePermission("OpportunityContactRole", "createable", roleFields);
    await service.write("OpportunityContactRole", {
      method: "POST",
      body: {
        OpportunityId: opportunityId,
        ContactId: contactId,
        Role: decisionMaker
      }
    });
    return { message: "Decision-maker contact role added in Salesforce." };
  } finally {
    writing.delete(key);
  }
}
