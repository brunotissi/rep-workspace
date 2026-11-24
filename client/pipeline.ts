import type { OpportunityReason } from "../server/opportunity-health";
import { calendarDay } from "../server/calendar";
import { ApiError } from "./api";
import type { workspace } from "../server/workspace";

export type PipelineData = Awaited<
  ReturnType<ReturnType<typeof workspace>["pipeline"]>
>;
export type SnapshotData = Awaited<
  ReturnType<ReturnType<typeof workspace>["snapshot"]>
>;
export type Row = PipelineData["rows"][number];
export type SortKey =
  "Name" | "accountName" | "StageName" | "CloseDate" | "Amount" | "health";
export const emptyFilters = {
  search: "",
  stage: "",
  health: "",
  reason: "",
  from: "",
  through: "",
  minimum: "",
  maximum: ""
};
const healthOrder = { Red: 0, Amber: 1, Green: 2 };
export const healthLabels = {
  Green: "Healthy",
  Amber: "At risk",
  Red: "Needs attention",
  Unavailable: "Unavailable"
};

export const healthReasonLabels = {
  overdue: "Overdue close date",
  closingSoon: "Closing within seven days",
  missingDecisionMaker: "No visible Decision Maker",
  unknownCloseDate: "Close date unavailable",
  unknownDecisionMaker: "Decision Maker coverage unavailable"
} satisfies Partial<Record<OpportunityReason, string>>;

export function healthReasonOptions(rows: Row[], selected: string) {
  const available = new Set(rows.flatMap((row) => row.health.reasonCodes));
  return (Object.keys(healthReasonLabels) as OpportunityReason[]).filter(
    (reason) =>
      (reason !== "unknownCloseDate" && reason !== "unknownDecisionMaker") ||
      reason === selected ||
      available.has(reason)
  );
}

export const closeDateMin = "1700-01-01";
export const closeDateMax = "4000-12-31";
type DateEndpoint = "from" | "through";
type DateRange = Pick<typeof emptyFilters, DateEndpoint>;

export const emptyCloseDates = {
  draft: { from: "", through: "" },
  applied: { from: "", through: "" },
  badInput: { from: false, through: false },
  errors: {} as Partial<DateRange>,
  revision: 0
};

export function resetCloseDates(state: typeof emptyCloseDates) {
  return { ...emptyCloseDates, revision: state.revision + 1 };
}

export function editCloseDates(
  state: typeof emptyCloseDates,
  endpoint: DateEndpoint,
  value: string,
  incomplete: boolean
) {
  const draft = { ...state.draft, [endpoint]: value };
  const badInput = { ...state.badInput, [endpoint]: incomplete };
  const errors: Partial<DateRange> = {};
  for (const key of ["from", "through"] as const) {
    const date = draft[key];
    if (badInput[key]) errors[key] = "Complete the date.";
    else if (
      /^\d{4,}-\d{2}-\d{2}$/.test(date) &&
      (date.length > 10 || date < closeDateMin || date > closeDateMax)
    )
      errors[key] = "Use a year from 1700 to 4000.";
    else if (date && !Number.isFinite(calendarDay(date)))
      errors[key] = "Enter a valid date.";
  }
  if (
    !errors.from &&
    !errors.through &&
    draft.from &&
    draft.through &&
    draft.from > draft.through
  )
    errors[endpoint] = "From must be on or before Through.";
  return {
    ...state,
    draft,
    badInput,
    errors,
    applied: errors.from || errors.through ? state.applied : draft
  };
}

export function accountDisplayName(name: string) {
  return name.replace(
    /^RW Demo [0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12} \| (?=\S)/,
    ""
  );
}

export function healthStatus(
  health?: Pick<Row["health"], "status" | "unassessed">
) {
  return health && !health.unassessed ? health.status : undefined;
}

export function decodePipeline(data: unknown): PipelineData {
  const pipeline = data as Partial<PipelineData> | null;
  if (
    typeof pipeline?.today !== "string" ||
    typeof pipeline.amountAvailable !== "boolean" ||
    !Array.isArray(pipeline.rows)
  )
    throw new ApiError(502, "The Pipeline response could not be read.");
  if (
    pipeline.healthScope !== "opportunity" ||
    pipeline.rows.some((row) => !Array.isArray(row?.health?.reasonCodes))
  )
    throw new ApiError(
      502,
      "The server and browser are running different Pipeline versions. Restart the local Rep Workspace server, then reload and sign in again."
    );
  if (
    pipeline.rows.some(
      ({ Id, Name, health }) =>
        typeof Id !== "string" ||
        typeof Name !== "string" ||
        !Object.hasOwn(healthOrder, health.status) ||
        typeof health.incomplete !== "boolean" ||
        (health.unassessed !== undefined &&
          typeof health.unassessed !== "boolean") ||
        !Array.isArray(health.reasons) ||
        health.reasons.some((reason) => typeof reason !== "string")
    )
  )
    throw new ApiError(
      502,
      "The server returned invalid Pipeline data. Retry to reload it."
    );
  return pipeline as PipelineData;
}

function filterChecks(filters: typeof emptyFilters) {
  const { search, stage, health, reason, from, through, minimum, maximum } =
    filters;
  const normalize = (value: string) =>
    value.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase();
  const tokens = normalize(search).trim().split(/\s+/).filter(Boolean);
  const checks: { label: string; matches: (row: Row) => boolean }[] = [];
  if (tokens.length)
    checks.push({
      label: "search",
      matches: (row) => {
        const names = normalize(
          row.Name + " " + accountDisplayName(row.accountName ?? "")
        );
        return tokens.every((token) => names.includes(token));
      }
    });
  if (stage)
    checks.push({ label: "stage", matches: (row) => row.StageName === stage });
  if (health)
    checks.push({
      label: "health",
      matches: (row) => (healthStatus(row.health) ?? "Unavailable") === health
    });
  if (reason)
    checks.push({
      label: "health reason",
      matches: (row) =>
        row.health.reasonCodes.includes(reason as OpportunityReason)
    });
  if (from || through)
    checks.push({
      label: "close date",
      matches: (row) =>
        Boolean(
          row.CloseDate &&
          Number.isFinite(calendarDay(row.CloseDate)) &&
          (!from || row.CloseDate >= from) &&
          (!through || row.CloseDate <= through)
        )
    });
  if (minimum || maximum)
    checks.push({
      label: "amount",
      matches: (row) =>
        row.Amount != null &&
        (!minimum || row.Amount >= Number(minimum)) &&
        (!maximum || row.Amount <= Number(maximum))
    });
  return checks;
}

export function excludingFilters(row: Row, filters: typeof emptyFilters) {
  return filterChecks(filters)
    .filter((check) => !check.matches(row))
    .map((check) => check.label);
}

export function healthCounts(rows: Row[], filters: typeof emptyFilters) {
  const checks = filterChecks({ ...filters, health: "" });
  const counts = { All: 0, Green: 0, Amber: 0, Red: 0 };
  for (const row of rows) {
    if (!checks.every((check) => check.matches(row))) continue;
    counts.All++;
    const status = healthStatus(row.health);
    if (status) counts[status]++;
  }
  return counts;
}

export function activeDimensions(filters: typeof emptyFilters) {
  const { stage, health, reason, from, through, minimum, maximum } = filters;
  return [
    { label: "Stage", value: stage, keys: ["stage"] },
    {
      label: "Close date",
      value: [from && "From " + from, through && "Through " + through]
        .filter(Boolean)
        .join(" · "),
      keys: ["from", "through"]
    },
    {
      label: "Amount",
      value: [minimum && "Min " + minimum, maximum && "Max " + maximum]
        .filter(Boolean)
        .join(" · "),
      keys: ["minimum", "maximum"]
    },
    {
      label: "Health",
      value: healthLabels[health as keyof typeof healthLabels],
      keys: ["health"]
    },
    {
      label: "Health reason",
      value: healthReasonLabels[reason as keyof typeof healthReasonLabels],
      keys: ["reason"]
    }
  ].filter(({ value }) => value);
}

export const pageSize = 50;
export function pipelinePage(
  rows: Row[],
  requested: number,
  followId?: string
) {
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const selectedIndex = followId
    ? rows.findIndex((row) => row.Id === followId)
    : -1;
  const page =
    selectedIndex >= 0
      ? Math.floor(selectedIndex / pageSize)
      : Math.min(Math.max(requested, 0), pages - 1);
  return {
    page,
    pages,
    selectedIndex,
    visible: rows.slice(page * pageSize, (page + 1) * pageSize)
  };
}

export function selectRows(
  rows: Row[],
  filters: typeof emptyFilters,
  sort: { key: SortKey; ascending: boolean }
) {
  const checks = filterChecks(filters);
  const value = (row: Row) => {
    if (sort.key === "accountName")
      return row.accountName ? accountDisplayName(row.accountName) : undefined;
    if (sort.key !== "health") return row[sort.key];
    const status = healthStatus(row.health);
    return status && healthOrder[status];
  };
  return rows
    .filter((row) => checks.every((check) => check.matches(row)))
    .sort((left, right) => {
      const a = value(left),
        b = value(right);
      if (a == null || b == null)
        return a == null && b == null
          ? left.Id.localeCompare(right.Id)
          : a == null
            ? 1
            : -1;
      const comparison =
        typeof a === "number" && typeof b === "number"
          ? a - b
          : String(a).localeCompare(String(b));
      return (
        comparison * (sort.ascending ? 1 : -1) ||
        left.Id.localeCompare(right.Id)
      );
    });
}
