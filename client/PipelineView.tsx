import { useMemo, useState, type ReactNode } from "react";
import {
  emptyFilters,
  selectRows,
  type PipelineData,
  type Row,
  type SortKey
} from "./pipeline";
import type { Health } from "../server/health";

const pageSize = 50;
const amountFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2
});
export function amountText({
  Amount,
  formattedAmount
}: Pick<Row, "Amount" | "formattedAmount">) {
  if (Amount === undefined) return "Unavailable";
  if (Amount === null) return "Not set";
  return (
    formattedAmount || amountFormat.format(Amount) + " (currency unavailable)"
  );
}
export function HealthBadge({ health }: { health?: Health }) {
  return (
    <div>
      <span className={"badge " + (health?.status.toLowerCase() ?? "unknown")}>
        {health?.status ?? "Unavailable"}
      </span>
      {health?.incomplete && <small>Incomplete data</small>}
    </div>
  );
}

const columns: { key: SortKey; label: string }[] = [
  { key: "StageName", label: "Stage" },
  { key: "CloseDate", label: "Close date" },
  { key: "Amount", label: "Amount" },
  { key: "health", label: "Health" }
];

export function Pipeline({
  data,
  selected,
  onSelect
}: {
  data: PipelineData;
  selected?: string;
  onSelect: (row: Row) => void;
}) {
  const [filters, setFilters] = useState(emptyFilters);
  const [sort, setSort] = useState<{ key: SortKey; ascending: boolean }>({
    key: "CloseDate",
    ascending: true
  });
  const [page, setPage] = useState(0);
  const stages = useMemo(
    () =>
      [
        ...new Set(data.rows.map((row) => row.StageName).filter(Boolean))
      ].sort(),
    [data.rows]
  );
  const rows = useMemo(
    () => selectRows(data.rows, filters, sort),
    [data.rows, filters, sort]
  );
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const visible = rows.slice(page * pageSize, (page + 1) * pageSize);

  function filter(key: keyof typeof filters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(0);
  }
  function selectFilter(
    key: "stage" | "health",
    label: string,
    options: (string | undefined)[]
  ) {
    return (
      <label>
        {label}
        <select
          value={filters[key]}
          onChange={(event) => filter(key, event.target.value)}
        >
          <option value="">Any</option>
          {options.map((option) => (
            <option key={option}>{option}</option>
          ))}
        </select>
      </label>
    );
  }
  function inputFilter(
    key: "from" | "through" | "minimum" | "maximum",
    label: string,
    type: "date" | "number"
  ) {
    return (
      <label>
        {label}
        <input
          type={type}
          step={type === "number" ? "any" : undefined}
          value={filters[key]}
          onChange={(event) => filter(key, event.target.value)}
        />
      </label>
    );
  }
  if (!data.rows.length)
    return (
      <p className="notice">
        You have no visible open opportunities in Salesforce.
      </p>
    );

  return (
    <>
      <fieldset className="filters">
        <legend>Filter opportunities</legend>
        {selectFilter("stage", "Stage", stages)}
        {selectFilter("health", "Health", [
          "Green",
          "Amber",
          "Red",
          "Unavailable"
        ])}
        {inputFilter("from", "Close from", "date")}
        {inputFilter("through", "Close through", "date")}
        {inputFilter("minimum", "Min amount", "number")}
        {inputFilter("maximum", "Max amount", "number")}
        <button
          className="quiet"
          onClick={() => {
            setFilters(emptyFilters);
            setPage(0);
          }}
        >
          Clear filters
        </button>
      </fieldset>
      <p className="table-summary" role="status">
        {rows.length} of {data.rows.length} opportunities
      </p>
      {!visible.length ? (
        <p className="notice">No opportunities match these filters.</p>
      ) : (
        <>
          <div
            className="table-scroll"
            role="region"
            aria-label="Pipeline table"
            tabIndex={0}
          >
            <table aria-label="Open opportunities">
              <thead>
                <tr>
                  <th scope="col">Opportunity / account</th>
                  {columns.map((column) => (
                    <th
                      key={column.key}
                      scope="col"
                      aria-sort={
                        sort.key === column.key
                          ? sort.ascending
                            ? "ascending"
                            : "descending"
                          : undefined
                      }
                    >
                      <button
                        className="sort"
                        onClick={() => {
                          setSort({
                            key: column.key,
                            ascending:
                              sort.key !== column.key || !sort.ascending
                          });
                          setPage(0);
                        }}
                      >
                        {column.label}{" "}
                        <span aria-hidden="true">
                          {sort.key === column.key
                            ? sort.ascending
                              ? "↑"
                              : "↓"
                            : "↕"}
                        </span>
                      </button>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <tr
                    key={row.Id}
                    className={selected === row.Id ? "selected" : undefined}
                  >
                    <th scope="row">
                      {row.AccountId && row.accountName ? (
                        <button
                          className="opportunity"
                          aria-pressed={selected === row.Id}
                          onClick={() => onSelect(row)}
                        >
                          {row.Name}
                        </button>
                      ) : (
                        row.Name
                      )}
                      <small>{row.accountName ?? "Account unavailable"}</small>
                    </th>
                    <td>{row.StageName ?? "Unavailable"}</td>
                    <td>
                      {row.CloseDate ?? "Unavailable"}
                      {row.CloseDate && row.CloseDate < data.today && (
                        <small className="overdue">Overdue</small>
                      )}
                    </td>
                    <td>{amountText(row)}</td>
                    <td>
                      <HealthBadge health={row.health} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <nav className="pagination" aria-label="Pipeline pages">
            <button
              className="quiet"
              disabled={page === 0}
              onClick={() => setPage((value) => value - 1)}
            >
              Previous
            </button>
            <span role="status">
              Page {page + 1} of {pages}
            </span>
            <button
              className="quiet"
              disabled={page + 1 >= pages}
              onClick={() => setPage((value) => value + 1)}
            >
              Next
            </button>
          </nav>
        </>
      )}
    </>
  );
}

export function ReadError({
  children,
  retry
}: {
  children: ReactNode;
  retry?: () => void;
}) {
  return (
    <div className="notice error">
      <p role="alert">{children}</p>
      {retry && (
        <button className="quiet" onClick={retry}>
          Retry
        </button>
      )}
    </div>
  );
}
