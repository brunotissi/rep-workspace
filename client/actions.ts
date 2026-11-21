import { ApiError } from "./api";
import type { ActionInput } from "../server/actions";

export async function submitAction(
  input: ActionInput
): Promise<{ message: string }> {
  let response: Response;
  try {
    response = await fetch("/api/actions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input)
    });
  } catch {
    throw new ApiError(
      0,
      "The save could not be confirmed. Check the refreshed Salesforce data before trying again.",
      true
    );
  }
  const result = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      response.status,
      result?.error ??
        (response.status === 401
          ? "Your Salesforce session expired. Sign in again."
          : "The action could not be saved."),
      typeof result?.uncertain === "boolean"
        ? result.uncertain
        : response.status >= 500
    );
  if (typeof result?.message !== "string")
    throw new ApiError(
      502,
      "The save could not be confirmed. Check the refreshed Salesforce data before trying again.",
      true
    );
  return result;
}

export function withCloseDate<T extends { Id: string; CloseDate?: string }>(
  rows: T[],
  change?: Pick<
    Extract<ActionInput, { kind: "closeDate" }>,
    "opportunityId" | "date"
  >
) {
  return change
    ? rows.map((row) =>
        row.Id === change.opportunityId
          ? { ...row, CloseDate: change.date }
          : row
      )
    : rows;
}

export async function runAction(
  action: ActionInput,
  callbacks: {
    preview: (
      action: Extract<ActionInput, { kind: "closeDate" }> | undefined
    ) => void;
    confirm: (message: string) => void;
    reject: (error: ApiError) => void;
    refresh: () => void;
  },
  submit = submitAction
) {
  if (action.kind === "closeDate") callbacks.preview(action);
  try {
    const result = await submit(action);
    callbacks.confirm(result.message);
    callbacks.refresh();
  } catch (caught) {
    const error =
      caught instanceof ApiError
        ? caught
        : new ApiError(
            0,
            "The save could not be confirmed. Check the refreshed Salesforce data.",
            true
          );
    callbacks.reject(error);
    if (error.uncertain || error.status === 409) callbacks.refresh();
  } finally {
    callbacks.preview(undefined);
  }
}
