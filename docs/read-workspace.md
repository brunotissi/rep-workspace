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

Verify is strict by default. An intentional demo edit to a seeded close date will cause it to report a mismatch against the original seed. Keep the original checkpoint and compare the exact Opportunity ID, original value, and approved new value with a read-only Salesforce query. Also recheck the open EUR count, owner, and relationships against the seed dataset. A separately created follow-up or contact role can be verified by its own ID. Use a new dataset GUID when you need a pristine seed for a repeatable demonstration.

## Verify the seeded dataset through the app

Restart the app and sign in as the configured owner. The pipeline endpoint scopes rows to the signed-in rep and returns Opportunity Health. In DevTools, count records by the exact dataset marker and summarize the row assessments without printing record data:

```js
const dataset = "<dataset GUID from PowerShell>";
const response = await fetch("/api/pipeline");
if (!response.ok)
  throw new Error("Pipeline request failed: " + response.status);
const { rows } = await response.json();
const seeded = rows.filter((row) =>
  row.accountName?.startsWith("RW Demo " + dataset + " | ")
);
const counts = { Green: 0, Amber: 0, Red: 0, Unavailable: 0 };
for (const { health } of seeded) {
  counts[!health || health.unassessed ? "Unavailable" : health.status]++;
}
const accounts = new Set(seeded.map((row) => row.AccountId)).size;
console.table({ opportunities: seeded.length, accounts, ...counts });
if (seeded.length !== 1080 || accounts !== 30) {
  throw new Error("Unexpected dataset size. Check ownership and visibility.");
}
```

Distributions depend on the business date, intentional fixture edits, and the viewer's permissions. Check health reasons on individual Pipeline rows and verify Account Health separately in Snapshot.

For performance evidence, disable the browser cache in DevTools, reload three times, and record the pipeline request durations, median, and transferred bytes. Check responsiveness by changing a filter and moving between pages on the large dataset. Neither operation should add a pipeline request. Record the actual observations rather than treating the offline fixture as a live measurement.

### Historical live performance (before Opportunity Health)

The 1,080-opportunity EUR demo dataset was verified in the browser. Three measured application requests to `/api/pipeline` took **1.26 s, 1.23 s, and 1.12 s** (median **1.23 s**). Sorting, filtering, and paging remained responsive and sent zero additional pipeline requests. See the [current benchmark and follow-up](delivery.md#performance-comparison).

## Next best actions

The selected opportunity can show up to three recommendations. The app ranks an overdue close date first, then missing or stale completed account activity (using the same 21-day evidence as health), then missing visible decision-maker coverage on the selected opportunity. An existing open workspace follow-up suppresses a second follow-up recommendation. Unknown evidence suppresses that rule. Salesforce object and field permissions determine which controls and contacts are available.

| Priority                     | Scope and trigger                                                                                                                                                          | Evidence and failure behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Required write access                                                                                                                                                                                     |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Update the close date     | Selected open Opportunity has a Close Date strictly before today (UTC).                                                                                                    | Reads Opportunity `Id` and `CloseDate`. An unreadable or missing date suppresses the recommendation.                                                                                                                                                                                                                                                                                                                                                                                                                       | Opportunity Edit, writable `CloseDate`, and an owned open record in the selected Account. The server checks the previous date before updating.                                                            |
| 2. Create a follow-up task   | The Account has visible stale activity or no visible completed activity, and there is no visible open Task named `Rep Workspace follow-up` linked directly to the Account. | Completed Tasks use `AccountId`, `IsClosed`, and due date `ActivityDate` on or before today. Ended Events use `AccountId`, `EndDateTime`, and `ActivityDate`. A date newer than UTC today minus 21 days is recent. Stale requires two successful recent checks, no recent evidence, and older visible evidence. No activity requires complete empty checks. The open follow-up lookup uses `Id`, `WhatId`, `IsClosed`, and `Subject`. Missing recency evidence or a failed follow-up lookup suppresses the recommendation. | Task Create and writable `WhatId`, `Subject`, `ActivityDate`, `Status`, and `Priority`. The server loads an open Task status and an active Priority.                                                      |
| 3. Identify a decision maker | A successful read finds no visible role with the exact value `Decision Maker` on the selected Opportunity.                                                                 | Reads `OpportunityContactRole.OpportunityId`, `ContactId`, and `Role`, scoped to visible open Opportunities on the Account. A failed role read suppresses the recommendation. No eligible Contact leaves the action unavailable.                                                                                                                                                                                                                                                                                           | Opportunity Edit, readable same-Account Contact, and either Contact Role Create with writable `OpportunityId`, `ContactId`, and `Role`, or Contact Role Update with writable `Role` for an existing pair. |

Health is Account-level. An overdue visible Opportunity can make every row on that Account show **Needs attention**. **Incomplete data** records an unknown input. If missing evidence is the only reason the Account could not be classified, the UI shows **Not assessed**. An inaccessible Task due date is hidden from the activity list and contributes no recency evidence. Amount filters and sorting are unavailable when Salesforce hides the Amount field.

The server checks the selected opportunity is open, belongs to the signed-in rep, and belongs to the selected account before writing. A contact must be visible and on that account. The role action updates an existing role for that contact or creates a Decision Maker role without changing the primary-contact flag. The date action compares the submitted previous date with Salesforce before saving. A single localhost process suppresses overlapping action requests for the same target. Salesforce still decides whether the write is allowed.

Run `npm test` to exercise recommendation ordering, action validation, writes against simulated Salesforce responses, and optimistic close-date rollback. No live Salesforce writes are needed for these tests.

The Pipeline previews a pending close date in place and keeps its original sort position until Salesforce confirms the write. After confirmation, it follows the selected row to its new page using the current sort and filters. If a criterion excludes the row, the selection stays open in the snapshot and the Pipeline offers to clear the search and filters and show the row. Search matches displayed Opportunity and Account names across the loaded data.

For a browser review, start the workspace and select **Cobalt Payments - Field expansion 02** on a freshly seeded dataset. On the anchor date it shows all three recommendations if the permissions and related records are still in their original state. Use Tab to reach each card and confirm the selected context and available inputs. Each live submission requires org-write approval. After approval, verify the saved Task, Close Date, and Opportunity Contact Role in Salesforce and check that the corresponding recommendations refresh. A remote time-out may leave the outcome unknown, in which case review the refreshed record before taking the action again.

### Deferred UX refinements

- The desktop-first Pipeline uses a horizontally scrollable table on narrow screens and a fixed page size of 50.
- Search matches a substring of the displayed Account or Opportunity name. View preferences reset when the workspace reloads.
- The action area shows one toast at a time for the current selection. Switching records clears it, and the next result replaces it.

## Restricted-user verification

Use a separate full Salesforce user with the **Minimum Access - Salesforce** profile and a dedicated permission set. Grant API Enabled and access to the existing external client app under its current policy. Grant Opportunity, Account, and Contact read access with the fields the workspace needs. Leave Opportunity Amount hidden and Opportunity Edit withheld for the restricted demonstration. Use separate browser profiles so each OAuth session runs under its own Salesforce identity. Leave organization-wide sharing settings in place.

Give the user a small, separately owned set of test Opportunities on a dedicated Account. The workspace requires an owned open Opportunity before opening its Account snapshot. Salesforce record sharing and field permissions still govern the account-wide supporting data within that view. If Task or Event reads are unavailable, the activity section reports partial data. Opportunity Contact Role reads depend on access to the Opportunity and Contact. Role writes also depend on Opportunity Edit and the applicable REST field permissions.

Use keyboard Tab and Shift+Tab from the skip link, through search and the table, across the pager, and into the Snapshot and actions. Verify visible focus at the first and last page, and that the scrollable Snapshot lists can be reached and scrolled. Check that field errors are linked to their inputs, health remains clear without color, and toast announcements leave focus with the user. At a narrow viewport the Pipeline table scrolls within its panel.

The local tests exercise mocked OAuth through the HTTP routes, including separate users and field permissions, token refresh and revocation, logout during an in-flight read, and forged cross-origin requests. Fault tests cover Salesforce quotas, record locks, partial reads, duplicate submissions, and uncertain saves without consuming API quota or changing live data. Separately verify real restricted-user field and write access in Salesforce after setup is approved.

### Milestone 4 verification results

The restricted user's browser showed two owned EUR Opportunities with Amount unavailable and write actions disabled. The Northstar Lab Snapshot displayed the completed Task on October 20, 2026. The administrator's Snapshot URL returned HTTP 404 in the restricted session. The follow-up lookup returned stale activity and no existing follow-up after adding read-only access to Task Due Date and Related To.

One direct Salesforce REST PATCH used the restricted user's OAuth identity and attempted to change the disposable **Northstar Lab - Late renewal** Close Date from November 15 to December 15, 2026. Salesforce returned **HTTP 400 / `CANNOT_INSERT_UPDATE_ACTIVATE_ENTITY`**. An administrator read confirmed the date remained November 15. The response establishes that Salesforce rejected the write. Separate effective-access checks confirmed that the user could read the Opportunity and Close Date and lacked update access.

The authenticated Snapshot's follow-up diagnostic exposes the rule and lookup states, HTTP status, allowlisted Salesforce error codes, and recognized Task field names as available. It omits raw Salesforce messages, query text, credentials, and token data. A failed lookup suppresses the recommendation.

Two manual accessibility checks remain outstanding: a screen-reader walkthrough of labels, errors, and toast announcements, and a narrow-viewport keyboard walkthrough of the table, pager, Snapshot lists, and action controls.
