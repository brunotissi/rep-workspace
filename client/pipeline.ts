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

export function accountDisplayName(name: string) {
  return name.replace(
    /^RW Demo [0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12} \| (?=\S)/,
    ""
  );
}

export function healthStatus(health: Row["health"]) {
  return health && !health.unassessed ? health.status : undefined;
}

function filterChecks(filters: typeof emptyFilters) {
  const { search, stage, health, from, through, minimum, maximum } = filters;
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
  if (from || through)
    checks.push({
      label: "close date",
      matches: (row) =>
        Boolean(
          row.CloseDate &&
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
  const { stage, health, from, through, minimum, maximum } = filters;
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
