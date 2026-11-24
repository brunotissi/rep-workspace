import {
  Fragment,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode
} from "react";
import {
  accountDisplayName,
  activeDimensions,
  closeDateMax,
  closeDateMin,
  editCloseDates,
  emptyCloseDates,
  healthCounts,
  pageSize,
  emptyFilters,
  healthReasonOptions,
  resetCloseDates,
  excludingFilters,
  healthLabels,
  healthReasonLabels,
  healthStatus,
  pipelinePage,
  selectRows,
  type PipelineData,
  type Row,
  type SortKey
} from "./pipeline";
import { WorkspaceIcon } from "./WorkspaceIcon";
import type { Health } from "../server/health";

const amountFormat = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 2
});
const dateFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeZone: "UTC"
});
const tableDateFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  timeZone: "UTC"
});
export function dateText(value?: string, formatter = dateFormat) {
  const timestamp = value ? Date.parse(value) : NaN;
  return Number.isFinite(timestamp)
    ? formatter.format(timestamp)
    : "Unavailable";
}
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
  { key: "Name", label: "Opportunity" },
  { key: "accountName", label: "Account" },
  { key: "StageName", label: "Stage" },
  { key: "Amount", label: "Amount" },
  { key: "CloseDate", label: "Close date" },
  { key: "health", label: "Health" }
];

export function Pipeline({
  data,
  selected,
  onSelect,
  follow,
  onFollow,
  onLeaveFollow,
  preview,
  onDetails
}: {
  data: PipelineData;
  selected?: string;
  onSelect: (row: Row) => void;
  follow?: { id: string };
  onFollow: (id: string) => void;
  onLeaveFollow: () => void;
  preview?: { opportunityId: string; date: string };
  onDetails?: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [explained, setExplained] = useState<string>();
  const filtersButton = useRef<HTMLButtonElement>(null);
  const [filters, setFilters] = useState(emptyFilters);
  const [closeDates, setCloseDates] = useState(emptyCloseDates);
  const [editingDate, setEditingDate] = useState<"from" | "through">();
  const dateError = (key: "from" | "through") =>
    editingDate === key && closeDates.badInput[key]
      ? undefined
      : closeDates.errors[key];
  const fromError = dateError("from");
  const throughError = dateError("through");
  const showDateErrors = Boolean(fromError || throughError);
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
  const effectiveFilters = useMemo(
    () => ({
      ...(data.amountAvailable
        ? filters
        : { ...filters, minimum: "", maximum: "" }),
      ...closeDates.applied
    }),
    [data.amountAvailable, filters, closeDates.applied]
  );
  const reasonOptions = useMemo(
    () => healthReasonOptions(data.rows, filters.reason),
    [data.rows, filters.reason]
  );
  const effectiveSort =
    !data.amountAvailable && sort.key === "Amount"
      ? { key: "CloseDate" as const, ascending: true }
      : sort;
  const rows = useMemo(
    () => selectRows(data.rows, effectiveFilters, effectiveSort),
    [data.rows, effectiveFilters, effectiveSort.key, effectiveSort.ascending]
  );
  const counts = useMemo(
    () => healthCounts(data.rows, effectiveFilters),
    [data.rows, effectiveFilters]
  );
  const dimensions = activeDimensions(effectiveFilters);
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
    ? excludingFilters(filteredSelection, effectiveFilters)
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

  function restartFilteredPage() {
    onLeaveFollow();
    setPage(0);
    if (tableRegion.current) tableRegion.current.scrollTop = 0;
  }
  function filter(key: keyof typeof filters, value: string) {
    setFilters((current) => ({ ...current, [key]: value }));
    restartFilteredPage();
  }
  function clearFilters() {
    setFilters(emptyFilters);
    setCloseDates(resetCloseDates);
  }
  function changePage(page: number, resetScroll = true) {
    if (resetScroll && tableRegion.current) tableRegion.current.scrollTop = 0;
    onLeaveFollow();
    setPage(page);
  }
  function selectFilter(
    key: "stage" | "health" | "reason",
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
                : key === "reason"
                  ? healthReasonLabels[
                      option as keyof typeof healthReasonLabels
                    ]
                  : option}
            </option>
          ))}
        </select>
      </label>
    );
  }
  function closeDateInput(key: "from" | "through", label: string) {
    const error = dateError(key);
    const errorId = "pipeline-close-" + key + "-error";
    return (
      <label key={key + "-" + closeDates.revision}>
        {label}
        <input
          type="date"
          min={closeDateMin}
          max={closeDateMax}
          value={closeDates.draft[key]}
          aria-invalid={error ? true : undefined}
          aria-describedby={
            error ? errorId + " pipeline-close-feedback" : undefined
          }
          onFocus={() => setEditingDate(key)}
          onBlur={() => setEditingDate(undefined)}
          onInput={(event) => {
            const input = event.currentTarget;
            const next = editCloseDates(
              closeDates,
              key,
              input.value,
              input.validity.badInput
            );
            setCloseDates(next);
            if (
              next.applied.from !== closeDates.applied.from ||
              next.applied.through !== closeDates.applied.through
            )
              restartFilteredPage();
          }}
        />
      </label>
    );
  }
  function amountInput(key: "minimum" | "maximum", label: string) {
    return (
      <label>
        {label}
        <input
          type="number"
          step="any"
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
      <div
        className="health-filters"
        role="group"
        aria-label="Filter by opportunity health"
      >
        {(["All", "Green", "Amber", "Red"] as const).map((status) => {
          const value = status === "All" ? "" : status;
          return (
            <button
              key={status}
              type="button"
              className="health-filter"
              aria-pressed={filters.health === value}
              onClick={() => filter("health", value)}
            >
              {status !== "All" && (
                <span
                  className={`health-dot ${status.toLowerCase()}`}
                  aria-hidden="true"
                />
              )}
              {status === "All" ? "All opportunities" : healthLabels[status]}
              <span className="health-count">
                {counts[status].toLocaleString()}
              </span>
            </button>
          );
        })}
      </div>
      <div className="pipeline-toolbar">
        <label className="pipeline-search">
          <span className="visually-hidden">
            Search opportunities and accounts
          </span>
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <circle cx="10" cy="10" r="6" />
            <path d="m15 15 5 5" />
          </svg>
          <input
            id="pipeline-search"
            type="search"
            placeholder="Search opportunities or accounts…"
            value={filters.search}
            onChange={(event) => filter("search", event.target.value)}
          />
        </label>
        <button
          className="quiet filter-toggle"
          type="button"
          ref={filtersButton}
          aria-expanded={expanded}
          aria-controls="advanced-filters"
          onClick={() => setExpanded(!expanded)}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
          >
            <path d="M3 5h18l-7 8v5l-4 2v-7z" />
          </svg>
          Filters{dimensions.length ? ` (${dimensions.length})` : ""}
          <WorkspaceIcon name="chevron" className="filter-chevron" />
        </button>
      </div>
      <fieldset
        className="filters panel"
        id="advanced-filters"
        hidden={!expanded}
      >
        <legend className="visually-hidden">
          Advanced opportunity filters
        </legend>
        {selectFilter("stage", "Stage", stages)}
        <div className="filter-range">
          {closeDateInput("from", "Close from")}
          {closeDateInput("through", "Close through")}
        </div>
        {data.amountAvailable ? (
          <div className="filter-range">
            {amountInput("minimum", "Min amount")}
            {amountInput("maximum", "Max amount")}
          </div>
        ) : null}
        {selectFilter("health", "Health", [
          "Green",
          "Amber",
          "Red",
          "Unavailable"
        ])}
        {selectFilter("reason", "Health reason", reasonOptions)}
        <div
          role="status"
          className={showDateErrors ? "date-filter-error" : "visually-hidden"}
        >
          {fromError && (
            <span id="pipeline-close-from-error">From: {fromError}</span>
          )}
          {throughError && (
            <span id="pipeline-close-through-error">
              Through: {throughError}
            </span>
          )}
          {showDateErrors && (
            <span id="pipeline-close-feedback">
              {closeDates.applied.from || closeDates.applied.through
                ? "Last valid range still applied."
                : "No date range applied."}
            </span>
          )}
        </div>
        <div className="filter-help">
          <small>Filters apply as you change them.</small>
          {!data.amountAvailable && (
            <small className="filter-permission">
              Amount filters are unavailable with your Salesforce access.
            </small>
          )}
        </div>
      </fieldset>
      {(dimensions.length > 0 || filters.search || showDateErrors) && (
        <div
          className="active-filters"
          role="group"
          aria-label="Applied filters"
        >
          {dimensions.map(({ label, value, keys }, index) => (
            <button
              type="button"
              className="filter-chip"
              key={label}
              aria-label={`Remove ${label} filter: ${value}`}
              onClick={(event) => {
                const next =
                  index < dimensions.length - 1
                    ? event.currentTarget.nextElementSibling
                    : filtersButton.current;
                if (next instanceof HTMLElement) next.focus();
                onLeaveFollow();
                if (keys.includes("from")) setCloseDates(resetCloseDates);
                setFilters((current) => ({
                  ...current,
                  ...Object.fromEntries(keys.map((key) => [key, ""]))
                }));
                setPage(0);
              }}
            >
              {label}: {value} <span aria-hidden="true">×</span>
            </button>
          ))}
          <button
            className="text-control"
            onClick={() => {
              filtersButton.current?.focus();
              onLeaveFollow();
              clearFilters();
              setPage(0);
            }}
          >
            Clear filters
          </button>
        </div>
      )}
      <div className="pipeline-meta">
        <p className="table-summary" role="status">
          {rows.length.toLocaleString()} of {data.rows.length.toLocaleString()}{" "}
          opportunities
        </p>
        {onDetails && (
          <button className="section-skip" onClick={onDetails}>
            Go to selected details
          </button>
        )}
      </div>
      {filteredSelection && hiddenBy.length > 0 && (
        <div className="notice filtered-selection">
          <p role="status">
            <strong>{filteredSelection.Name}</strong> is still selected. It no
            longer matches the current {hiddenBy.join(", ")} criteria.
          </p>
          <button
            className="quiet"
            onClick={() => {
              clearFilters();
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
          <div className="panel table-panel">
            <div
              ref={tableRegion}
              className="table-scroll"
              role="region"
              aria-label="Pipeline table"
              tabIndex={0}
            >
              <table aria-label="Open opportunities">
                <colgroup>
                  {columns.map(({ key }) => (
                    <col key={key} className={`column-${key}`} />
                  ))}
                </colgroup>
                <thead>
                  <tr>
                    {columns.map((column) => (
                      <th
                        key={column.key}
                        scope="col"
                        aria-sort={
                          (data.amountAvailable || column.key !== "Amount") &&
                          effectiveSort.key === column.key
                            ? effectiveSort.ascending
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
                              changePage(0);
                              setSort({
                                key: column.key,
                                ascending:
                                  effectiveSort.key !== column.key ||
                                  !effectiveSort.ascending
                              });
                            }}
                          >
                            {column.label}{" "}
                            <span className="sort-indicator" aria-hidden="true">
                              {effectiveSort.key === column.key
                                ? effectiveSort.ascending
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
                    const overdue = Boolean(
                      closeDate && closeDate < data.today
                    );
                    const overdueId = overdue
                      ? "close-date-overdue-" + row.Id
                      : undefined;
                    const account = row.accountName
                      ? accountDisplayName(row.accountName)
                      : "Account unavailable";
                    const stage = row.StageName ?? "Unavailable";
                    const amount = amountText(row);
                    const selectable = Boolean(
                      row.AccountId && row.accountName
                    );
                    return (
                      <Fragment key={row.Id}>
                        <tr
                          ref={selected === row.Id ? selectedRow : undefined}
                          className={
                            selected === row.Id ? "selected" : undefined
                          }
                          data-selectable={selectable || undefined}
                          onClick={
                            selectable
                              ? () => {
                                  changePage(page, false);
                                  onSelect(row);
                                }
                              : undefined
                          }
                        >
                          <th scope="row">
                            {selectable ? (
                              <button
                                type="button"
                                className="opportunity"
                                aria-pressed={selected === row.Id}
                                aria-describedby={overdueId}
                                title={row.Name}
                              >
                                {row.Name}
                              </button>
                            ) : (
                              <span className="cell-text" title={row.Name}>
                                {row.Name}
                              </span>
                            )}
                          </th>
                          <td className="account-cell">
                            <span className="cell-text" title={account}>
                              {account}
                            </span>
                          </td>
                          <td>
                            <span className="cell-text" title={stage}>
                              {stage}
                            </span>
                          </td>
                          <td>
                            <span className="cell-text" title={amount}>
                              {amount}
                            </span>
                          </td>
                          <td>
                            <div
                              className={
                                overdue
                                  ? "table-close-date is-overdue"
                                  : "table-close-date"
                              }
                              title={
                                overdue
                                  ? "Overdue — close date has passed"
                                  : undefined
                              }
                            >
                              {closeDate ? (
                                <time
                                  dateTime={closeDate}
                                  title={
                                    overdue ? undefined : dateText(closeDate)
                                  }
                                >
                                  {dateText(closeDate, tableDateFormat)}
                                </time>
                              ) : (
                                <span>Unavailable</span>
                              )}
                              {overdue && (
                                <>
                                  <WorkspaceIcon name="caution" />
                                  <span
                                    id={overdueId}
                                    className="visually-hidden"
                                  >
                                    Overdue — close date has passed
                                  </span>
                                </>
                              )}
                            </div>
                            {previewed && (
                              <span className="visually-hidden">
                                Saving date…
                              </span>
                            )}
                          </td>
                          <td>
                            <button
                              type="button"
                              className="opportunity-health"
                              aria-label={`Opportunity health for ${row.Name}: ${healthLabels[healthStatus(row.health) ?? "Unavailable"]}`}
                              aria-expanded={explained === row.Id}
                              aria-controls={
                                explained === row.Id
                                  ? "health-" + row.Id
                                  : undefined
                              }
                              onClick={(event) => {
                                event.stopPropagation();
                                setExplained((current) =>
                                  current === row.Id ? undefined : row.Id
                                );
                              }}
                            >
                              <HealthBadge health={row.health} />
                            </button>
                          </td>
                        </tr>
                        {explained === row.Id && (
                          <tr
                            className="health-explanation"
                            id={"health-" + row.Id}
                          >
                            <td colSpan={columns.length}>
                              <strong>Opportunity health reasons</strong>
                              <ul>
                                {(
                                  row.health?.reasons ?? [
                                    "Opportunity health could not be assessed."
                                  ]
                                ).map((reason) => (
                                  <li key={reason}>{reason}</li>
                                ))}
                              </ul>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            <nav className="pagination" aria-label="Pipeline pages">
              <span className="page-range">
                {(page * pageSize + 1).toLocaleString()}–
                {(page * pageSize + visible.length).toLocaleString()} of{" "}
                {rows.length.toLocaleString()}
              </span>
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
          </div>
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
