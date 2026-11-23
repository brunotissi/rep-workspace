import { calendarDay, closeProximityDays } from "./calendar";

const explanations = {
  overdue: "The opportunity close date has passed.",
  closingSoon: "The opportunity closes within seven calendar days.",
  missingDecisionMaker:
    "No Decision Maker contact role is visible on this opportunity.",
  unknownCloseDate: "The close date is unavailable.",
  unknownDecisionMaker: "Decision Maker coverage could not be assessed.",
  covered:
    "The close date is more than seven days away and a Decision Maker is visible."
} as const;

export type OpportunityReason = keyof typeof explanations;

export type OpportunityHealth = {
  status: "Red" | "Amber" | "Green";
  incomplete: boolean;
  unassessed?: boolean;
  reasonCodes: OpportunityReason[];
  reasons: string[];
};

export function opportunityHealth(
  closeDate: string | undefined,
  decisionMaker: boolean | undefined,
  today: string
): OpportunityHealth {
  const days = calendarDay(closeDate) - calendarDay(today);
  const overdue = days < 0;
  const soon = days >= 0 && days <= closeProximityDays;
  const missing = decisionMaker === false;
  const reasonCodes: OpportunityReason[] = [];
  if (overdue) reasonCodes.push("overdue");
  if (soon) reasonCodes.push("closingSoon");
  if (missing) reasonCodes.push("missingDecisionMaker");
  if (!Number.isFinite(days)) reasonCodes.push("unknownCloseDate");
  if (decisionMaker === undefined) reasonCodes.push("unknownDecisionMaker");
  const incomplete = !Number.isFinite(days) || decisionMaker === undefined;
  const status =
    overdue || (soon && missing)
      ? "Red"
      : soon || missing || incomplete
        ? "Amber"
        : "Green";
  if (status === "Green") reasonCodes.push("covered");
  return {
    status,
    incomplete,
    unassessed: incomplete && !overdue && !soon && !missing,
    reasonCodes,
    reasons: reasonCodes.map((code) => explanations[code])
  };
}
