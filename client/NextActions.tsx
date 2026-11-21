import type { FormEvent } from "react";
import type { ActionInput, recommendations } from "../server/actions";
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
    <section className="next-actions" aria-labelledby="next-actions-title">
      <h3 id="next-actions-title">Next best actions</h3>
      {actions.pendingTask && (
        <p>An open workspace follow-up already exists on this account.</p>
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
      <ul>
        {actions.items.map((item) => {
          const invalid = validation?.kind === item.kind;
          const description = invalid
            ? "action-validation-" + item.kind
            : undefined;
          return (
            <li className="action-card" key={item.kind}>
              <h4>{item.title}</h4>
              <p>{item.reason}</p>
              {item.unavailable ? (
                <p className="action-unavailable">{item.unavailable}</p>
              ) : (
                <form
                  onChange={() => onInputChange(item.kind)}
                  onSubmit={(event) => submit(event, item.kind)}
                >
                  <fieldset disabled={blocked || Boolean(pending)}>
                    {item.kind === "contactRole" ? (
                      <label>
                        Contact
                        <select
                          name="contact"
                          defaultValue=""
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
                          defaultValue={item.kind === "task" ? today : ""}
                          min={today}
                          max="2099-12-31"
                          required
                          aria-invalid={invalid || undefined}
                          aria-describedby={description}
                        />
                      </label>
                    )}
                    <button type="submit" className="primary">
                      {pending === item.kind
                        ? "Saving…"
                        : item.kind === "task"
                          ? "Create task"
                          : item.kind === "closeDate"
                            ? "Save close date"
                            : "Save contact role"}
                    </button>
                  </fieldset>
                  {invalid && (
                    <p className="field-validation" id={description}>
                      {validation.message}
                    </p>
                  )}
                </form>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
