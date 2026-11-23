import { useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { ActionInput, recommendations } from "../server/actions";
import { WorkspaceIcon } from "./WorkspaceIcon";
import type { SnapshotData } from "./pipeline";

export type ActionRecommendations = Awaited<ReturnType<typeof recommendations>>;

export function NextActions({
  snapshot,
  selected,
  blocked,
  pending,
  validation,
  onInputChange,
  onAction
}: {
  snapshot: SnapshotData & { actions?: ActionRecommendations };
  selected: { Id: string; Name: string };
  blocked: boolean;
  pending?: ActionInput["kind"];
  validation?: { kind: ActionInput["kind"]; message: string };
  onInputChange: (kind: ActionInput["kind"]) => void;
  onAction: (action: ActionInput) => void;
}) {
  const { actions, contacts, today } = snapshot;
  // Workspace keys this component by opportunity ID. Keep drafts in React
  // so the mounted controls cannot reuse a previous record's native values.
  const [draft, setDraft] = useState<
    Partial<Record<ActionInput["kind"], string>>
  >({});
  function updateDraft(kind: ActionInput["kind"], value: string) {
    setDraft((current) => ({ ...current, [kind]: value }));
  }
  const heading = useRef<HTMLHeadingElement>(null);
  const focusedAction = useRef<ActionInput["kind"] | undefined>(undefined);
  useLayoutEffect(() => {
    if (
      focusedAction.current &&
      document.activeElement === document.body &&
      !actions?.items.some(
        (item) => item.kind === focusedAction.current && !item.unavailable
      )
    ) {
      heading.current?.focus();
      focusedAction.current = undefined;
    }
  });
  if (!actions) return null;
  const existing =
    "data" in snapshot.opportunities
      ? snapshot.opportunities.data.find((row) => row.Id === selected.Id)
      : undefined;
  const context = {
    accountId: snapshot.account.Id,
    opportunityId: selected.Id
  };
  function submit(
    event: FormEvent<HTMLFormElement>,
    kind: ActionInput["kind"]
  ) {
    event.preventDefault();
    if (blocked || pending) return;
    const fields = new FormData(event.currentTarget);
    const date = String(fields.get("date") ?? "");
    if (kind === "task") onAction({ ...context, kind, date });
    if (kind === "closeDate" && existing?.CloseDate)
      onAction({ ...context, kind, date, previousDate: existing.CloseDate });
    if (kind === "contactRole")
      onAction({
        ...context,
        kind,
        contactId: String(fields.get("contact") ?? "")
      });
  }

  return (
    <section
      className="panel next-actions"
      aria-labelledby="next-actions-title"
    >
      <h2 id="next-actions-title" ref={heading} tabIndex={-1}>
        <WorkspaceIcon name="action" /> Next Best Actions
      </h2>
      {actions.pendingTask && (
        <p>An open workspace follow-up already exists on this account.</p>
      )}
      {"followUp" in actions && actions.followUp?.lookup === "failed" && (
        <p role="status">
          The app could not check for an existing follow-up Task. The follow-up
          recommendation is unavailable.
        </p>
      )}
      {actions.incomplete && (
        <p>
          Some Salesforce information is unavailable. Suggestions use the data
          you can see.
        </p>
      )}
      {!actions.items.length && (
        <p>
          No additional rule-based actions are currently recommended for this
          opportunity.
        </p>
      )}
      <ul className="action-workflow">
        {actions.items.map((item) => {
          const invalid = validation?.kind === item.kind;
          const description = invalid
            ? "action-validation-" + item.kind
            : undefined;
          return (
            <li
              className="action-card"
              key={item.kind}
              onFocus={() => {
                focusedAction.current = item.kind;
              }}
              onBlur={(event) => {
                if (event.relatedTarget) focusedAction.current = undefined;
              }}
            >
              <span className="action-marker">
                <WorkspaceIcon
                  name={
                    item.kind === "contactRole"
                      ? "contact"
                      : item.kind === "task"
                        ? "action"
                        : "calendar"
                  }
                />
              </span>
              <div className="action-step">
                <header className="action-heading">
                  <h3>{item.title}</h3>
                  <p>{item.reason}</p>
                </header>
                {item.unavailable ? (
                  <p className="action-unavailable">{item.unavailable}</p>
                ) : (
                  <form
                    className="action-form"
                    onChange={() => onInputChange(item.kind)}
                    onSubmit={(event) => submit(event, item.kind)}
                  >
                    <fieldset disabled={blocked || Boolean(pending)}>
                      {item.kind === "contactRole" ? (
                        <label>
                          Contact
                          <select
                            name="contact"
                            value={draft.contactRole ?? ""}
                            onChange={(event) =>
                              updateDraft("contactRole", event.target.value)
                            }
                            required
                            aria-invalid={invalid || undefined}
                            aria-describedby={description}
                          >
                            <option value="" disabled>
                              Choose a contact
                            </option>
                            {"data" in contacts &&
                              contacts.data
                                .filter((contact) =>
                                  item.eligibleContactIds?.includes(contact.Id)
                                )
                                .map((contact) => (
                                  <option key={contact.Id} value={contact.Id}>
                                    {contact.Name}
                                  </option>
                                ))}
                          </select>
                        </label>
                      ) : (
                        <label>
                          {item.kind === "task" ? "Due date" : "New close date"}
                          <input
                            name="date"
                            type="date"
                            value={
                              draft[item.kind] ??
                              (item.kind === "task" ? today : "")
                            }
                            onChange={(event) =>
                              updateDraft(item.kind, event.target.value)
                            }
                            min={today}
                            max="2099-12-31"
                            required
                            aria-invalid={invalid || undefined}
                            aria-describedby={description}
                          />
                        </label>
                      )}
                      {invalid && (
                        <p className="field-validation" id={description}>
                          {validation.message}
                        </p>
                      )}
                      <div className="action-footer">
                        <button type="submit" className="primary">
                          {pending === item.kind
                            ? "Saving…"
                            : item.kind === "task"
                              ? "Create task"
                              : item.kind === "closeDate"
                                ? "Save close date"
                                : "Save contact role"}
                        </button>
                      </div>
                    </fieldset>
                  </form>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
