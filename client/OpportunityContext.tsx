import { amountText, dateText } from "./PipelineView";
import { WorkspaceIcon } from "./WorkspaceIcon";
import type { Row } from "./pipeline";

export function OpportunityContext({
  row,
  date,
  onReturn,
  onActions
}: {
  row: Row;
  date?: string;
  onActions?: () => void;
  onReturn: () => void;
}) {
  return (
    <section
      className="panel opportunity-context"
      aria-labelledby="selected-title"
    >
      <div className="context-header">
        <span className="context-label">Opportunity details</span>
        <h2 id="selected-title" tabIndex={-1}>
          {row.Name}
        </h2>
        {onActions && (
          <button className="section-skip" onClick={onActions}>
            Go to actions
          </button>
        )}
        <button className="section-skip" onClick={onReturn}>
          Back to Pipeline
        </button>
      </div>
      <dl className="context-facts">
        <div>
          <WorkspaceIcon name="layers" />
          <dt className="visually-hidden">Amount</dt>
          <dd>{amountText(row)}</dd>
        </div>
        <div>
          <WorkspaceIcon name="stage" />
          <dt className="visually-hidden">Stage</dt>
          <dd>{row.StageName ?? "Unavailable"}</dd>
        </div>
        <div>
          <WorkspaceIcon name="calendar" />
          <dt className="visually-hidden">Close date</dt>
          <dd>{dateText(date ?? row.CloseDate)}</dd>
        </div>
      </dl>
    </section>
  );
}
