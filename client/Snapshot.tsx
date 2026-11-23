import type { ReactNode } from "react";
import { HealthBadge, ReadError, amountText, dateText } from "./PipelineView";
import { WorkspaceIcon } from "./WorkspaceIcon";
import {
  accountDisplayName,
  healthStatus,
  type SnapshotData
} from "./pipeline";

function ListSection<T>({
  title,
  icon,
  scrollable,
  result,
  empty,
  render
}: {
  title: string;
  icon: "contact" | "layers";
  scrollable?: boolean;
  result: { data: T[] } | { error: string };
  empty: string;
  render: (item: T) => ReactNode;
}) {
  return (
    <section
      className={
        scrollable
          ? "snapshot-section snapshot-open"
          : "snapshot-section snapshot-contacts"
      }
    >
      <h3>
        <WorkspaceIcon name={icon} /> {title}
      </h3>
      {"error" in result ? (
        <p role="status">{result.error}</p>
      ) : result.data.length ? (
        <ul
          aria-label={title}
          className={scrollable ? "snapshot-opportunities" : undefined}
          tabIndex={scrollable ? 0 : undefined}
        >
          {result.data.map(render)}
        </ul>
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
  const decisionMakerIds = new Set(data.decisionMakerIds);
  const selectedDecisionMakerIds = data.selectedDecisionMakerIds
    ? new Set(data.selectedDecisionMakerIds)
    : // An older Snapshot can prove that every visible role is on another
      // opportunity only when its selected-opportunity check returned false.
      data.selectedDecisionMaker === false
      ? new Set<string>()
      : undefined;
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
      <div
        className="snapshot-overview"
        role="region"
        aria-label="Account overview"
        tabIndex={0}
      >
        <div className="account-summary">
          <div className="account-heading">
            <span className="account-emblem">
              <WorkspaceIcon name="account" />
            </span>
            <div>
              <h3>{accountDisplayName(account.Name)}</h3>
              <p>Owner · {account.Owner?.Name ?? "Unavailable"}</p>
            </div>
          </div>
          {"error" in health ? (
            <ReadError>{health.error}</ReadError>
          ) : (
            <section
              className={
                "health-summary health-" +
                (healthStatus(health.data)?.toLowerCase() ?? "unknown")
              }
              aria-label="Account health"
            >
              <div className="health-summary-title">
                <h3>Account health</h3>
                <HealthBadge health={health.data} />
              </div>
              <ul className="reasons">
                {health.data.reasons.map((reason) => (
                  <li key={reason}>{reason}</li>
                ))}
              </ul>
            </section>
          )}
        </div>
        <ListSection
          title="Key contacts"
          icon="contact"
          result={keyContacts}
          empty="No contacts are visible."
          render={(contact) => {
            const initials = contact.Name.trim()
              .split(/\s+/)
              .slice(0, 2)
              .map((name) => Array.from(name)[0])
              .join("")
              .toLocaleUpperCase();
            return (
              <li key={contact.Id} className="contact-row">
                <span className="contact-monogram" aria-hidden="true">
                  {initials}
                </span>
                <div className="contact-copy">
                  <div className="contact-identity">
                    <strong>{contact.Name}</strong>
                    {selectedDecisionMakerIds &&
                      decisionMakerIds.has(contact.Id) && (
                        <span className="contact-role">
                          Decision maker ·{" "}
                          {selectedDecisionMakerIds.has(contact.Id)
                            ? "This opportunity"
                            : "Other opportunity"}
                        </span>
                      )}
                  </div>
                  {contact.Title && <small>{contact.Title}</small>}
                </div>
              </li>
            );
          }}
        />
        <section className="snapshot-section">
          <h3>
            <WorkspaceIcon name="activity" /> Recent activity
          </h3>
          {"error" in tasks && <p role="status">Tasks: {tasks.error}</p>}
          {"error" in events && <p role="status">Events: {events.error}</p>}
          {"data" in tasks && tasks.datesUnavailable && (
            <p>
              Task dates are unavailable. Visible completed Tasks are shown
              without dates.
            </p>
          )}
          {timeline.length ? (
            <ul className="activity-timeline" aria-label="Recent activity">
              {timeline.map((item) => (
                <li key={item.Id}>
                  <strong>{item.Subject ?? "Subject unavailable"}</strong>
                  <small>
                    {item.kind} · {dateText(item.date)}
                  </small>
                </li>
              ))}
            </ul>
          ) : (
            "data" in tasks &&
            "data" in events && <p>No recent activity is visible.</p>
          )}
        </section>
      </div>
      <ListSection
        title="Open opportunities"
        icon="layers"
        scrollable
        result={opportunities}
        empty="No open opportunities are visible."
        render={(row) => (
          <li key={row.Id}>
            <strong>{row.Name}</strong>
            <small>
              {row.StageName ?? "Stage unavailable"} · {dateText(row.CloseDate)}{" "}
              · {amountText(row)}
            </small>
            {row.CloseDate && row.CloseDate < today && (
              <small className="overdue">Overdue</small>
            )}
          </li>
        )}
      />
    </>
  );
}
