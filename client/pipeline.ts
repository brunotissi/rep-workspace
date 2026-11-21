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
  stage: "",
  health: "",
  from: "",
  through: "",
  minimum: "",
  maximum: ""
};
const healthOrder = { Red: 0, Amber: 1, Green: 2 };

export function selectRows(
  rows: Row[],
  filters: typeof emptyFilters,
  sort: { key: SortKey; ascending: boolean }
) {
  const { stage, health, from, through, minimum, maximum } = filters;
  const amountMatches = (amount: Row["Amount"]) =>
    (!minimum && !maximum) ||
    (amount != null &&
      (!minimum || amount >= Number(minimum)) &&
      (!maximum || amount <= Number(maximum)));
  const value = (row: Row) =>
    sort.key === "health"
      ? row.health && healthOrder[row.health.status]
      : row[sort.key];
  return rows
    .filter(
      (row) =>
        (!stage || row.StageName === stage) &&
        (!health || (row.health?.status ?? "Unavailable") === health) &&
        (!from || (row.CloseDate && row.CloseDate >= from)) &&
        (!through || (row.CloseDate && row.CloseDate <= through)) &&
        amountMatches(row.Amount)
    )
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
