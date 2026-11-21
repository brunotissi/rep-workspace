# Read-only workspace

Restart with `npm.cmd run dev` and open `http://localhost:5173`. Sign in through the External Client App as the Salesforce user who owns the demo opportunities. The workspace shows open opportunities owned by that user. Selecting an opportunity opens its account snapshot, including other open opportunities the same Salesforce session can read.

## Account health

Health reflects the current user's Salesforce visibility. Close-date and activity cutoff rules use the server's UTC date. Activities are completed tasks and past events associated with the account. Decision-maker coverage comes from visible `Decision Maker` roles on open opportunities.

| Health | Rule                                                                                                                                                                                                                               |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Red    | A visible open opportunity is overdue, or visible activity exists and all known activity is at least 21 days old. Stale activity requires both recent-activity queries to succeed.                                                 |
| Amber  | No Red condition applies and at least one signal needs attention. Examples include a close date from today through seven days out, no visible open opportunities, no visible activity or decision maker, or an unavailable signal. |
| Green  | Recent activity, readable open pipeline, closest close date more than seven days away, and visible decision-maker coverage.                                                                                                        |

An incomplete health calculation displays a text label and explains which signals are unavailable. The app distinguishes an empty successful read from a failed read. An individual snapshot section can fail while the rest remains usable. Salesforce formats the displayed amount in the authorized user's locale. Sorts and range filters operate on the raw record amounts, with no exchange-rate conversion.

## Verification

1. In the pipeline, sort Stage, Close date, Amount, and Health in both directions. Apply stage, date, amount and health filters, clear them, and use Previous and Next. Confirm a filter with no possible matches shows an empty result.
2. Tab to an opportunity and press Enter or Space. Confirm the selection, account name and owner update. Check the health explanation, overdue labels, contacts, and activity timeline.
3. After approved seed execution, confirm 1,080 demo opportunities in the rep's pipeline. In browser developer tools, reload and record the `/api/pipeline` duration and transferred bytes. Sort and filter with the Network tab open and confirm these controls add no Salesforce requests. The table renders up to 50 rows at a time and filtering and sorting cover the loaded result.
4. Before restricted-user validation, sign out and confirm the pipeline is replaced by the sign-in screen. Use the later restricted-user setup to verify field visibility and access against the real org.

## Seed the scale-test dataset

The script creates 30 accounts, 1,080 open opportunities, 60 contacts, 30 completed tasks, and 20 decision-maker roles. Each account gets 36 opportunities, two contacts, and one account-linked task. Opportunity currency is set explicitly and defaults to EUR. Use `-OpportunityCurrency` to choose another active ISO code, and use the same value for Apply and Verify. Salesforce multi-currency must be enabled, with the chosen currency active. On the anchor date each group has ten accounts:

| Scenario | Closest close date | Completed task | Decision maker |
| -------- | ------------------ | -------------- | -------------- |
| Green    | 14 days out        | 3 days ago     | Yes            |
| Amber    | 2 days out         | 8 days ago     | No             |
| Red      | 5 days overdue     | 29 days ago    | Yes            |

Run from the repository root. Set the target CLI alias and the exact username shown in the workspace. Keep the generated dataset ID and anchor date together for verification and recovery. Use a new ID for an independent dataset.

```powershell
./scripts/seed-demo.ps1 -Mode Plan
$seed = @{
  TargetOrg = '<CLI alias or username>'
  OwnerUsername = '<exact username shown in Rep Workspace>'
  DatasetId = [guid]::NewGuid()
  AsOf = [DateTime]::UtcNow.ToString('yyyy-MM-dd')
}
$seed
# After approval, run Apply once. Use the same values for any retry.
./scripts/seed-demo.ps1 @seed -Mode Apply
./scripts/seed-demo.ps1 @seed -Mode Verify
```

The CLI resolves the target owner in the selected org and explicitly sets ownership on accounts, contacts, tasks and opportunities. IDs for relationships are read back from Salesforce. Reuse requires an exact dataset marker in the description, the expected key and relationships, and the correct owner. Roles are identified through their two verified parent records and role value. The script refuses conflicting keys, inserts only missing records, and verifies the results. Run one process per dataset. Each batch is atomic, while completed batches from a failed run can remain. Allow an in-flight request to finish before retrying. Custom org automation, record types and duplicate rules can affect inserts. The script has no delete mode because deleting an account can also delete records added outside the seed.

## Verify the seeded dataset through the app

Restart the app, sign in as the configured owner, and open DevTools. The pipeline endpoint uses the actual app filters for ownership and the production account health rules. Run this in the console with the GUID printed by PowerShell:

```js
const dataset = "<dataset GUID from PowerShell>";
const response = await fetch("/api/pipeline");
if (!response.ok)
  throw new Error("Pipeline request failed: " + response.status);
const { rows } = await response.json();
const seeded = rows.filter((row) =>
  row.accountName?.startsWith("RW Demo " + dataset + " | ")
);
const accounts = new Map(seeded.map((row) => [row.AccountId, row.health]));
const counts = { Green: 0, Amber: 0, Red: 0, Incomplete: 0 };
for (const health of accounts.values()) {
  counts[health?.status ?? "Incomplete"]++;
  if (health?.incomplete) counts.Incomplete++;
}
console.table({
  opportunities: seeded.length,
  accounts: accounts.size,
  ...counts
});
if (
  seeded.length !== 1080 ||
  accounts.size !== 30 ||
  counts.Green !== 10 ||
  counts.Amber !== 10 ||
  counts.Red !== 10 ||
  counts.Incomplete !== 0
) {
  throw new Error(
    "Unexpected seeded dataset or health distribution. Check visibility, dates, and health reasons."
  );
}
```

Verify on the UTC anchor date. Health follows current dates, so later runs can legitimately change the distribution. In the UI, filter each health, spot-check one seeded snapshot per color, and compare amount/currency against the Salesforce record. Clear filters and check the first and last page, then sort Amount in both directions and apply a stage and close-date range. Confirm counts and page position reset when filters change.

For performance evidence, disable the browser cache in DevTools, reload three times, and record the pipeline request durations, median, and transferred bytes. Check responsiveness by changing a filter and moving between pages on the large dataset. Neither operation should add a pipeline request. Record the actual observations rather than treating the offline fixture as a live measurement.

### Verified performance

The 1,080-opportunity EUR demo dataset was verified in the browser. Three measured application requests to `/api/pipeline` took **1.26 s, 1.23 s, and 1.12 s** (median **1.23 s**). Sorting, filtering, and paging remained responsive and sent zero additional pipeline requests. The app batches Salesforce reads by account, uses query continuation when needed, and renders up to 50 rows per page.
