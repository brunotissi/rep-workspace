export function SelectionPlaceholder({
  loading,
  hasPipeline,
  unavailable = false
}: {
  loading: boolean;
  hasPipeline: boolean;
  unavailable?: boolean;
}) {
  if (!hasPipeline) {
    return loading ? (
      <div className="selection-empty" aria-hidden="true">
        <div className="selection-skeleton">
          <span />
          <span />
          <span />
        </div>
      </div>
    ) : null;
  }
  return (
    <div className="selection-empty">
      <svg
        className="selection-illustration"
        viewBox="0 0 144 108"
        aria-hidden="true"
        fill="none"
      >
        <rect
          x="5"
          y="5"
          width="134"
          height="98"
          rx="28"
          fill="var(--table-heading)"
        />
        <rect
          x="24"
          y="23"
          width="80"
          height="61"
          rx="10"
          fill="var(--surface)"
          stroke="#A9B9AE"
          strokeWidth="1.5"
        />
        <path
          d="M38 37h50m-50 34h38"
          stroke="#A9B9AE"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <rect
          x="32"
          y="45"
          width="64"
          height="17"
          rx="5"
          fill="var(--table-selected)"
        />
        <path
          d="M40 53h34"
          stroke="#537555"
          strokeWidth="2"
          strokeLinecap="round"
        />
        <path
          d="m92 54 27 14-12 3 5 12-6 3-5-12-8 8z"
          fill="var(--surface)"
          stroke="var(--forest)"
          strokeWidth="2"
          strokeLinejoin="round"
        />
      </svg>
      <div>
        <h2>Select an opportunity</h2>
        <p>
          {unavailable
            ? "The selected opportunity is no longer available in your pipeline. Select another opportunity to continue."
            : "Choose an opportunity from the Pipeline to review account context and take the next best action."}
        </p>
      </div>
    </div>
  );
}
