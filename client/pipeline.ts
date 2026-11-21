import type { workspace } from "../server/workspace";

export type PipelineData = Awaited<
  ReturnType<ReturnType<typeof workspace>["pipeline"]>
>;
export type SnapshotData = Awaited<
  ReturnType<ReturnType<typeof workspace>["snapshot"]>
>;
export type Row = PipelineData["rows"][number];
export type SortKey = "StageName" | "CloseDate" | "Amount" | "health";
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

function filterChecks(filters: typeof emptyFilters) {
  const { search, stage, health, from, through, minimum, maximum } = filters;
  const term = search.trim().toLowerCase();
  const checks: { label: string; matches: (row: Row) => boolean }[] = [];
  if (term)
    checks.push({
      label: "search",
      matches: (row) =>
        row.Name.toLowerCase().includes(term) ||
        accountDisplayName(row.accountName ?? "")
          .toLowerCase()
          .includes(term)
    });
  if (stage)
    checks.push({ label: "stage", matches: (row) => row.StageName === stage });
  if (health)
    checks.push({
      label: "health",
      matches: (row) => (row.health?.status ?? "Unavailable") === health
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
  const value = (row: Row) =>
    sort.key === "health"
      ? row.health && healthOrder[row.health.status]
      : row[sort.key];
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
