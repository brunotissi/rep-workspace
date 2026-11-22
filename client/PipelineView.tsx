import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  accountDisplayName,
  emptyFilters,
  excludingFilters,
  healthLabels,
  healthStatus,
  pipelinePage,
  selectRows,
  type PipelineData,
  type Row,
  type SortKey
} from "./pipeline";
import type { Health } from "../server/health";

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
  const status = healthStatus(health);
  return (
    <div>
      <span className={"badge " + (status?.toLowerCase() ?? "unknown")}>
        <span className="health-dot" aria-hidden="true" />
        {health?.unassessed
          ? "Not assessed"
          : healthLabels[status ?? "Unavailable"]}
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
  onSelect,
  follow,
  onFollow,
  onLeaveFollow,
  preview
}: {
  data: PipelineData;
  selected?: string;
  onSelect: (row: Row) => void;
  follow?: { id: string };
  onFollow: (id: string) => void;
  onLeaveFollow: () => void;
  preview?: { opportunityId: string; date: string };
}) {
  const [filters, setFilters] = useState(emptyFilters);
  const [sort, setSort] = useState<{ key: SortKey; ascending: boolean }>({
    key: "CloseDate",
    ascending: true
  });
  const [requestedPage, setPage] = useState(0);
  const tableRegion = useRef<HTMLDivElement>(null);
  const selectedRow = useRef<HTMLTableRowElement>(null);
  const stages = useMemo(
    () =>
      [
        ...new Set(data.rows.map((row) => row.StageName).filter(Boolean))
      ].sort(),
    [data.rows]
  );
  const rows = useMemo(
    () =>
      selectRows(
        data.rows,
        data.amountAvailable
          ? filters
          : { ...filters, minimum: "", maximum: "" },
        !data.amountAvailable && sort.key === "Amount"
          ? { key: "CloseDate", ascending: true }
          : sort
      ),
    [data.rows, data.amountAvailable, filters, sort]
  );
  const followId = follow?.id === selected ? follow?.id : undefined;
  const { page, pages, visible, selectedIndex } = pipelinePage(
    rows,
    requestedPage,
    followId
  );
  const filteredSelection =
    followId && selectedIndex < 0
      ? data.rows.find((row) => row.Id === followId)
      : undefined;
  const hiddenBy = filteredSelection
    ? excludingFilters(
        filteredSelection,
        data.amountAvailable
          ? filters
          : { ...filters, minimum: "", maximum: "" }
      )
    : [];
  useEffect(() => {
    const region = tableRegion.current;
    const row = selectedRow.current;
    if (
      !follow ||
      follow.id !== selected ||
      selectedIndex < 0 ||
      !region ||
      !row
    )
      return;
    const bounds = region.getBoundingClientRect();
    const rowBounds = row.getBoundingClientRect();
    const headerHeight =
      region.querySelector("thead")?.getBoundingClientRect().height ?? 0;
    if (rowBounds.top < bounds.top + headerHeight)
      region.scrollTop += rowBounds.top - bounds.top - headerHeight;
    else if (rowBounds.bottom > bounds.bottom)
      region.scrollTop += rowBounds.bottom - bounds.bottom;
  }, [follow, selected, selectedIndex, page]);

  function filter(key: keyof typeof filters, value: string) {
    onLeaveFollow();
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(0);
  }
  function changePage(page: number) {
    onLeaveFollow();
    setPage(page);
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
            <option key={option} value={option}>
              {key === "health"
                ? healthLabels[option as keyof typeof healthLabels]
                : option}
            </option>
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
        <label className="pipeline-search">
          Search opportunities and accounts
          <input
            type="search"
            value={filters.search}
            onChange={(event) => filter("search", event.target.value)}
          />
        </label>
        {selectFilter("stage", "Stage", stages)}
        {selectFilter("health", "Health", [
          "Green",
          "Amber",
          "Red",
          "Unavailable"
        ])}
        {inputFilter("from", "Close from", "date")}
        {inputFilter("through", "Close through", "date")}
        {data.amountAvailable ? (
          <>
            {inputFilter("minimum", "Min amount", "number")}
            {inputFilter("maximum", "Max amount", "number")}
          </>
        ) : (
          <p>Amount filters are unavailable with your Salesforce access.</p>
        )}
        <button
          className="quiet"
          onClick={() => {
            onLeaveFollow();
            setFilters(emptyFilters);
            setPage(0);
          }}
        >
          Clear search and filters
        </button>
      </fieldset>
      <p className="table-summary" role="status">
        {rows.length} of {data.rows.length} opportunities
      </p>
      {filteredSelection && hiddenBy.length > 0 && (
        <div className="notice filtered-selection">
          <p role="status">
            <strong>{filteredSelection.Name}</strong> is still selected. It no
            longer matches the current {hiddenBy.join(", ")} criteria.
          </p>
          <button
            className="quiet"
            onClick={() => {
              setFilters(emptyFilters);
              onFollow(filteredSelection.Id);
            }}
          >
            Clear search and filters and show row
          </button>
        </div>
      )}
      {!visible.length ? (
        <p className="notice">
          No opportunities match the current search and filters.
        </p>
      ) : (
        <>
          <div
            ref={tableRegion}
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
                        (data.amountAvailable || column.key !== "Amount") &&
                        sort.key === column.key
                          ? sort.ascending
                            ? "ascending"
                            : "descending"
                          : undefined
                      }
                    >
                      {column.key === "Amount" && !data.amountAvailable ? (
                        column.label
                      ) : (
                        <button
                          className="sort"
                          onClick={() => {
                            onLeaveFollow();
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
                      )}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => {
                  const previewed = preview?.opportunityId === row.Id;
                  const closeDate = previewed ? preview.date : row.CloseDate;
                  return (
                    <tr
                      key={row.Id}
                      ref={selected === row.Id ? selectedRow : undefined}
                      className={selected === row.Id ? "selected" : undefined}
                    >
                      <th scope="row">
                        {row.AccountId && row.accountName ? (
                          <button
                            className="opportunity"
                            aria-pressed={selected === row.Id}
                            onClick={() => {
                              changePage(page);
                              onSelect(row);
                            }}
                          >
                            {row.Name}
                          </button>
                        ) : (
                          row.Name
                        )}
                        <small>
                          {row.accountName
                            ? accountDisplayName(row.accountName)
                            : "Account unavailable"}
                        </small>
                      </th>
                      <td>{row.StageName ?? "Unavailable"}</td>
                      <td>
                        {closeDate ?? "Unavailable"}
                        {previewed && <small>Saving date…</small>}
                        {closeDate && closeDate < data.today && (
                          <small className="overdue">Overdue</small>
                        )}
                      </td>
                      <td>{amountText(row)}</td>
                      <td>
                        <HealthBadge health={row.health} />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <nav className="pagination" aria-label="Pipeline pages">
            <button
              className="quiet"
              aria-disabled={page === 0}
              aria-label="Previous pipeline page"
              onClick={() => {
                if (page > 0) changePage(page - 1);
              }}
            >
              Previous
            </button>
            <span role="status">
              Page {page + 1} of {pages}
            </span>
            <button
              className="quiet"
              aria-disabled={page + 1 >= pages}
              aria-label="Next pipeline page"
              onClick={() => {
                if (page + 1 < pages) changePage(page + 1);
              }}
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
