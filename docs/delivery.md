# Delivery and verification

## Architecture and rules

The Pipeline previously gathered account-level health and repeated it on all related rows. It now loads open Opportunities owned by the session user, batches Account names separately, and aggregates visible Decision Maker roles using those exact Opportunity IDs. Each SOQL request includes at most 175 IDs and returns at most one group per ID. Up to three concurrent requests run per window. The shared query reader supports Salesforce continuation for record queries. Permission and limit failures stop later windows; unavailable batches never establish a negative. Salesforce sharing still determines what can be seen. A successful empty role read means no role was visible to the current user.

| Assessment  | Precedence and inputs                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Account     | Red for a visible overdue deal or stale visible account activity. Amber for an approaching close, no visible open pipeline/activity/Decision Maker, or incomplete inputs. Green requires recent activity, a visible open pipeline, no close within seven days, and visible Decision Maker coverage. If incomplete inputs leave no known risk, present the result as unavailable.                                            |
| Opportunity | Red for an overdue close, or close from today through day seven plus confirmed missing coverage. Amber for either near-term date or confirmed missing coverage when there is no Red condition. Green requires a close after day seven and confirmed visible Decision Maker coverage. With insufficient evidence and no known risk, display Unavailable. Known risks retain their classification when other data is unknown. |

For example, an overdue Opportunity stays Red if roles are unreadable, and its future sibling can be Unavailable. A deal closing in seven days with missing coverage is Red, while an otherwise equivalent deal closing in eight days is Amber. Pipeline badges, filtering, counts, sorting and expandable explanations read the same assessment. Account health stays in Snapshot. Task/Event records currently provide reliable account-linked evidence for this application. Opportunity activity is omitted from Opportunity Health because the fixture and current account-level queries cannot reliably assign activity to a specific Opportunity.

The API returns stable reason codes and human-readable reasons. The business day is UTC, generated once per assessment request through an injectable clock. Calendar dates are parsed strictly and compared at whole-day boundaries. The confirmed close-date update recalculates local health before refresh, using the preceding role evidence, and Salesforce refresh reconciles it. Pending writes retain existing rollback and duplicate-prevention behavior.

### Security and reliability

OAuth uses PKCE and state, server-held tokens, local HTTP-only session cookies and same-origin mutation checks. Salesforce REST calls use the current user's OAuth session. App context checks restrict writes to the signed-in rep's Open Opportunity and matching Account. The existing action layer checks its required capabilities and lets Salesforce make the final record-level decision. Validation failures, limits and record locks use safe messages. Ambiguous writes trigger a refresh rather than blind retries. Session state is in memory and requires sign-in after restart. The existing platform policy remains authoritative for licensing, CRUD, FLS and sharing.

### Performance comparison

Eight isolated synthetic runs per version, discarding the first, with 1,080 rows, 30 Accounts, one opportunity response page, and 35 ms simulated latency per upstream request. The payload figure is uncompressed JSON. Filter timing is the median per-call average over 100 Node filter-and-sort iterations. It does not include browser paint.

| Metric                            | Milestone 5 | Opportunity Health |
| --------------------------------- | ----------: | -----------------: |
| Median Pipeline service time      |    179.7 ms |           232.9 ms |
| Upstream calls including describe |           8 |                 11 |
| JSON payload                      |   425,118 B |          428,416 B |
| Filter and sort                   |    0.738 ms |           0.663 ms |

The previous live median of 1.23 s was measured under different conditions. The final build has no new authenticated Pipeline timing. For a comparable live measurement, restart, authenticate, disable browser cache, and record three Pipeline timings and payload sizes on the same dataset. Change search, stage and health, then page and confirm no additional Pipeline calls. The Chrome fixture verified interaction, not live scale timing.

### Stretch decisions

Thresholds remain typed code and documented, since runtime editing adds an authorization and validation surface. For interview scenarios, change the relevant rule and run its boundary tests. Salesforce provides record history where configured, so no second audit store was added. Uncertain writes reconcile through the existing refresh flow, while the UI allows users to retry failed reads. Automatic non-idempotent write retries are excluded. A pre-build Figma artifact cannot be supplied retroactively.

## Demo outline

1. **0:00–0:40** Sign in as admin. Show the 1,080-row count, use search and a Stage filter, then sort and page.
2. **0:40–1:30** Compare two sibling Opportunities. Expand a Pipeline health explanation and explain how it differs from their shared Account Health. Show Account owner, overdue open deals, contacts, and activity.
3. **1:30–2:45** With approval and disposable records, demonstrate all three actions, outcome toasts, and cleared recommendations. Explain duplicate protection and close-date reconciliation.
4. **2:45–3:35** Switch to the restricted profile. Show unavailable Amount and its filter treatment, disabled writes and independent Salesforce scope.
5. **3:35–4:15** Show an approved simulation of a failed save or partial read. Use keyboard to open Health reasons. Point to the reproducible seed, tests, and native migration plan.
