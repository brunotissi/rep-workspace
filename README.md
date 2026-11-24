# Rep Workspace

A localhost Salesforce workspace for account executives. See an open pipeline, understand why a deal needs attention, and take action without leaving the page.

## Run it locally

1. Use Node.js 24 with npm, Git, Salesforce CLI, Windows PowerShell for seeding, and a Salesforce Developer Edition org.
2. In Salesforce Setup, create or configure an External Client App with OAuth authorization code flow and PKCE. Set the callback to `http://localhost:5173/auth/callback`. Enable API access, OpenID identity, and refresh-token access. Authorize the intended admin and restricted users under the app's OAuth policy. See the [setup guide](docs/read-workspace.md#configure-salesforce-oauth) for exact scopes and assignment.
3. Copy `.env.example` to `.env`. Set `SF_CLIENT_ID` to the consumer key and `SF_CLIENT_SECRET` to the consumer secret. `SF_LOGIN_URL` defaults to the production login origin and can use your Salesforce My Domain. Keep the local file private.
4. Run `npm ci`, then `npm run dev`. Open `http://localhost:5173` and sign in through the app. Salesforce CLI authentication is separate.

Use [the seed instructions](docs/read-workspace.md#seed-the-scale-test-dataset) to plan and create 1,080 open EUR opportunities and their related records in a disposable demo org. Preserve the generated dataset ID and UTC anchor for Verify and resume. The script supports a read-only Plan mode and refuses conflicting dataset keys.

Run `npm test`, `npm run prettier:verify`, `npm run build`, and `git diff --check`. Run `powershell -NoProfile -File tests/seed-demo.test.ps1` for mocked seed and recovery tests. See [restricted-user setup and verification](docs/read-workspace.md) for the dedicated fixture. Use a separate browser profile, sign in as the restricted rep, and confirm that Amount is unavailable and write controls are disabled where Salesforce denies access.

## Four UX decisions

1. **Find a deal without hunting across Accounts.** Search both names, combine filters, and sort the full pipeline locally. Show 50 rows at a time and preserve the selected record when it moves.
2. **Understand risk at the right scope.** Pipeline shows Opportunity Health with expandable reasons and a reason filter for prioritizing work. Snapshot shows Account Health and the signals behind it. Two deals on the same Account can differ.
3. **Act with context.** Show up to three explainable actions using the selected deal and account evidence. Distinguish a Decision Maker on this deal from one on another open deal.
4. **Know whether a save worked.** Show confirmed results with accessible feedback, preserve inline validation, and reconcile Salesforce state when a write outcome is uncertain.

## Architecture and rules

React and TypeScript handle selection, filters, and action drafts. Express holds OAuth tokens server-side and calls Salesforce REST with the signed-in user's authorization. The Pipeline starts from that rep's open Opportunities and batches related reads. Snapshot independently reads the selected account's visible evidence. Calculated assessments are never written to Salesforce. Each applicable recommendation has one submit action after any required date or Contact input. When no rule applies, the workspace shows a resolved state.

- **Opportunity Health** is critical if overdue or due within seven calendar days with no visible Decision Maker. It is at risk for either near-term close or confirmed missing coverage alone, healthy only for a later close with visible coverage, and unavailable when missing inputs leave no confirmed risk.
- **Account Health** combines activity recency, open pipeline, closest close date, and visible Decision Maker coverage on open deals. The existing 21-day activity and seven-day proximity rules are preserved. A failed evidence read cannot stand in for an empty successful result.
- Seven calendar days highlight deals due within a working week, and 21 days give a rep a clear follow-up cadence. UTC provides one reproducible date boundary for Salesforce date-only values. The layout is desktop-first for comparing deals across columns, with a responsive workspace at narrow widths. Local filtering avoids a network round trip per change, and 50-row pages keep rendered work bounded. Amount ranges assume comparable currencies. [Detailed rules and evidence](docs/delivery.md) cover precedence and permissions.

In five cache-disabled Chrome runs with **1,080 live Salesforce Opportunities**, Pipeline GET took **953 ms median / 1,529 ms maximum**. Across **45** local interactions, estimated time to paint was **33.4 ms median / 53.2 ms maximum**, with **zero additional Pipeline requests**. The localhost harness used the production app, live REST reads and controlled local session setup. It excluded OAuth sign-in time and estimated interaction timing with two animation-frame callbacks. This baseline predates the latest minor UI refinements. Batching related reads, local filtering and 50-row rendering kept work bounded.

## Native Salesforce migration

Place the cross-account workspace on a Lightning App Page and offer a compact LWC on Opportunity Record Pages when record context is useful. Use Lightning Data Service and wire adapters for supported record reads and writes. Use Apex with sharing and user-mode queries for batched cross-record evidence where wire adapters are insufficient. Preserve field-level access and surface unavailable inputs. Use Dynamic Forms for record-field presentation and Dynamic Actions for contextual quick actions. Keep validation rules, permissions, sharing, and straightforward Flow automation declarative so policy remains enforceable across every entry point. Keep deterministic cross-record assessments and their tests in code.

## Next steps

Validate timezone and refresh-date semantics with reps, then evaluate configurable thresholds based on their follow-up cadence. Before broader rollout, test larger pipelines and concurrent writes, then migrate supported record interactions to native Salesforce incrementally.
