export type Health = {
  status: "Green" | "Amber" | "Red";
  reasons: string[];
  incomplete: boolean;
};

type Evidence = {
  activity: "recent" | "stale" | "none" | undefined;
  openCount: number | undefined;
  nearestClose: string | null | undefined;
  decisionMaker: boolean | undefined;
};

export function accountHealth(evidence: Evidence, today: string): Health {
  const reasons: string[] = [];
  let critical = false;
  const daysFromToday = (date: string) =>
    (Date.parse(date.slice(0, 10)) - Date.parse(today)) / 86_400_000;
  const { activity, openCount, nearestClose, decisionMaker } = evidence;
  const incomplete =
    activity === undefined ||
    openCount === undefined ||
    Boolean(openCount && !nearestClose) ||
    decisionMaker === undefined;

  if (activity === undefined)
    reasons.push("Activity information is unavailable.");
  else if (activity === "none")
    reasons.push("No completed task or past event is visible.");
  else if (activity === "stale") {
    critical = true;
    reasons.push("Last visible activity was at least 21 days ago.");
  }

  if (openCount === undefined)
    reasons.push("Open pipeline information is unavailable.");
  else if (!openCount) reasons.push("No open opportunities are visible.");
  if (openCount && !nearestClose)
    reasons.push("Close-date information is unavailable.");
  if (nearestClose && daysFromToday(nearestClose) < 0) {
    critical = true;
    reasons.push("A visible open opportunity is overdue.");
  } else if (nearestClose && daysFromToday(nearestClose) <= 7)
    reasons.push("An open opportunity closes within seven days.");

  if (decisionMaker === undefined)
    reasons.push("Decision-maker coverage is unavailable.");
  else if (!decisionMaker)
    reasons.push("No decision-maker role is visible on open opportunities.");

  if (!reasons.length)
    return {
      status: "Green",
      incomplete,
      reasons: [
        "Recent activity, open pipeline, and a visible decision maker. No close date is within seven days."
      ]
    };
  return { status: critical ? "Red" : "Amber", incomplete, reasons };
}
