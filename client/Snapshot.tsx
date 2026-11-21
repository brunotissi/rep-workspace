import type { ReactNode } from "react";
import { HealthBadge, ReadError, amountText } from "./PipelineView";
import { accountDisplayName, type SnapshotData } from "./pipeline";

function ListSection<T>({
  title,
  result,
  empty,
  render
}: {
  title: string;
  result: { data: T[] } | { error: string };
  empty: string;
  render: (item: T) => ReactNode;
}) {
  return (
    <section className="snapshot-section">
      <h3>{title}</h3>
      {"error" in result ? (
        <p role="status">{result.error}</p>
      ) : result.data.length ? (
        <ul>{result.data.map(render)}</ul>
      ) : (
        <p>{empty}</p>
      )}
    </section>
  );
}

export function Snapshot({ data }: { data: SnapshotData }) {
  const { account, today, opportunities, contacts, tasks, events, health } =
    data;
  const timeline = [
    ...("data" in tasks
      ? tasks.data.map((task) => ({
          ...task,
          kind: "Task",
          date: task.ActivityDate
        }))
      : []),
    ...("data" in events
      ? events.data.map((event) => ({
          ...event,
          kind: "Event",
          date: event.ActivityDateTime
        }))
      : [])
  ]
    .sort(
      (left, right) =>
        (right.date ?? "").localeCompare(left.date ?? "") ||
        left.Id.localeCompare(right.Id)
    )
    .slice(0, 10);
  const unavailable = [
    ...("error" in tasks ? ["Tasks"] : []),
    ...("error" in events ? ["Events"] : [])
  ];
  const decisionMakerIds = new Set(data.decisionMakerIds);
  const keyContacts =
    "data" in contacts
      ? {
          data: [...contacts.data].sort(
            (a, b) =>
              Number(decisionMakerIds.has(b.Id)) -
              Number(decisionMakerIds.has(a.Id))
          )
        }
      : contacts;
  return (
    <>
      <div className="account-heading">
        <div>
          <h3>{accountDisplayName(account.Name)}</h3>
          <p>Owner · {account.Owner?.Name ?? "Unavailable"}</p>
        </div>
        <HealthBadge health={"data" in health ? health.data : undefined} />
      </div>
      {"error" in health ? (
        <ReadError>{health.error}</ReadError>
      ) : (
        <ul className="reasons">
          {health.data.reasons.map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      )}
      <ListSection
        title="Open opportunities"
        result={opportunities}
        empty="No open opportunities are visible."
        render={(row) => (
          <li key={row.Id}>
            <strong>{row.Name}</strong>
            <small>
              {row.StageName ?? "Stage unavailable"} ·{" "}
              {row.CloseDate ?? "Date unavailable"} · {amountText(row)}
            </small>
            {row.CloseDate && row.CloseDate < today && (
              <small className="overdue">Overdue</small>
            )}
          </li>
        )}
      />
      <ListSection
        title="Contacts"
        result={keyContacts}
        empty="No contacts are visible."
        render={(contact) => (
          <li key={contact.Id}>
            <strong>{contact.Name}</strong>
            {(contact.Title || decisionMakerIds.has(contact.Id)) && (
              <small>
                {[
                  decisionMakerIds.has(contact.Id) && "Decision maker",
                  contact.Title
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </small>
            )}
          </li>
        )}
      />
      <section className="snapshot-section">
        <h3>Recent activity</h3>
        {unavailable.length > 0 && (
          <p role="status">{unavailable.join(" and ")} could not be loaded.</p>
        )}
        {timeline.length ? (
          <ul>
            {timeline.map((item) => (
              <li key={item.Id}>
                <strong>{item.Subject ?? "Subject unavailable"}</strong>
                <small>
                  {item.kind} · {item.date?.slice(0, 10) ?? "Date unavailable"}
                </small>
              </li>
            ))}
          </ul>
        ) : (
          unavailable.length === 0 && <p>No recent activity is visible.</p>
        )}
      </section>
    </>
  );
}
