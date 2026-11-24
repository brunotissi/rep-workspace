# Local setup and operations

## Prerequisites

Use a Salesforce Developer Edition org, Git, Node.js 24 with its bundled npm, and a current Salesforce CLI (`sf`). Use **Windows PowerShell 5.1 or later** for the seed and offline seed tests. The current benchmark used Node.js 26.13.1 on Windows. Reserve localhost port 5173. The browser application and Salesforce CLI authenticate separately.

## Configure Salesforce OAuth

In Salesforce Setup, open **External Client App Manager** and create a local External Client App, or edit an existing one. Enable OAuth and configure the **OAuth 2.0 Web Server Flow** (authorization code), with callback URL `http://localhost:5173/auth/callback`. Require PKCE. The server sends the consumer secret for both code exchange and refresh, so it supports the corresponding secret requirements. Select these scopes:

| Salesforce scope               | Requested value                                    |
| ------------------------------ | -------------------------------------------------- |
| Manage user data via APIs      | `api`                                              |
| Perform requests at any time   | `refresh_token` (also shown with `offline_access`) |
| Access unique user identifiers | `openid`                                           |

For a controlled demo, use **Admin approved users are pre-authorized** under the app's OAuth policy and authorize the admin and restricted rep through the appropriate profile or permission-set assignments. Confirm API Enabled for both identities and that the refresh policy allows an eligible token during the demo. Keep the org's sharing, session and IP policies in place. [Salesforce OAuth scopes](https://help.salesforce.com/s/articleView?id=remoteaccess_oauth_tokens_scopes.htm&language=en_US) · [External Client App settings](https://help.salesforce.com/s/articleView?id=xcloud.configure_external_client_app_oauth_settings.htm&language=en_US)

From the repository root in PowerShell:

```powershell
Copy-Item .env.example .env
npm.cmd ci
npm.cmd run dev
```

Before starting, put the generated consumer key in `SF_CLIENT_ID` and consumer secret in `SF_CLIENT_SECRET` in the local `.env` file. `SF_LOGIN_URL` defaults to `https://login.salesforce.com`; for an org requiring its own login domain, use the HTTPS Salesforce My Domain origin with no path. Keep `.env` private. Open **http://localhost:5173** and complete Salesforce sign-in in the browser. Restarting the process clears in-memory app sessions.

## Seed the scale-test dataset

Use a disposable org. Enable Multiple Currencies and confirm **EUR is active** under **Manage Currencies**. Enabling multiple currencies is a permanent org setting. Use an active seed owner and an authorized CLI account that can read and create Accounts, Opportunities, Contacts, Tasks and Opportunity Contact Roles. The org needs active open Opportunity stages, a closed Task status, a Task priority and an active `Decision Maker` role. [Salesforce multi-currency setup](https://help.salesforce.com/s/articleView?id=sales.admin_enable_multicurrency.htm&language=en_US)

```powershell
sf org login web --alias rep-demo
./scripts/seed-demo.ps1 -Mode Plan

$seed = @{
  TargetOrg           = 'rep-demo'
  OwnerUsername       = '<exact username used in the browser>'
  DatasetId           = [guid]::NewGuid()
  AsOf                = [DateTime]::UtcNow.ToString('yyyy-MM-dd')
  OpportunityCurrency = 'EUR'
}
$seed
# Save the exact values privately and verify the CLI org before Apply.
./scripts/seed-demo.ps1 @seed -Mode Apply
./scripts/seed-demo.ps1 @seed -Mode Verify
```

**Apply creates Salesforce records.** It produces 30 Accounts, 1,080 open Opportunities, 60 Contacts, 30 completed Tasks and 20 Decision Maker roles. Plan uses no Salesforce access. Verify reads the named dataset without writing. Use the same tuple for repeat or recovery and run one process at a time. A failed batch stops the run. Earlier batches may have persisted, so inspect the outcome before resuming. The script checks seed keys and markers, inserts missing rows, and has no delete mode. A changed seeded Close Date can cause strict Verify to report drift. Choose a new dataset GUID only for a separate dataset.

Sign into the app as the seeded owner. Pipeline includes all that owner's open Opportunities, so pre-existing sample records may add to the total. The seed's ten Green, ten Amber and ten Red groups describe **Account Health at the anchor date**. Pipeline Opportunity Health is calculated separately and changes with today's UTC date and visible evidence.

## Set up and demonstrate the restricted rep

Create a separate user with the **Salesforce** license and **Minimum Access - Salesforce** profile. Assign a dedicated permission set with API Enabled, the External Client App assignment where policy requires it, and scoped read access. Use normal Salesforce invitation and password setup. Keep broad access and write grants out of the demo permission assignment.

| Object                             | Read access for this walkthrough                                                                                                                                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Opportunity                        | Open records it owns, with Name, Account, Stage and Close Date readable. Withhold Amount and Opportunity Edit.                                                                                                                                 |
| Account and Contact                | Visible fixture Accounts, including Account name and owner, and their Contacts, including name, title and Account association. Sharing still applies.                                                                                          |
| Task                               | Read only for fixture activity. Keep Subject, Due Date (`ActivityDate`) and Related To (`WhatId`) readable, along with Account (`AccountId`) and closed status (`IsClosed`) for the activity queries. Withhold Create, Edit and Delete.        |
| Event and Opportunity Contact Role | Allow read of visible fixture evidence where supported. Event recency uses Account, Subject, `ActivityDateTime` and `EndDateTime`. Role coverage uses Opportunity, Contact and Role. Withhold Contact Role writes and parent Opportunity Edit. |

Use a separate test Account with two open Opportunities owned by the restricted rep, a visible Contact, a completed Account-linked Task and one Decision Maker role on one Opportunity. Tune the dates relative to the current UTC day: one overdue, one later than seven days, and activity at least 21 days old if demonstrating stale activity. Use separate browser profiles for admin and rep. The rep should see only its own two Pipeline rows, Unavailable Amount, no Amount sort or filter, and permission explanations for applicable write actions. Admin and restricted sessions should remain independent. Activity and contact-role visibility depend on effective Salesforce access. Partial reads are surfaced without inventing missing business evidence.

## Operate and verify

- Search matches all normalized words across the combined Opportunity and displayed Account names. Filters apply locally, and date limits are inclusive. Dates outside 1700–4000 or a reversed draft range leave the last valid range applied. Table pages contain up to 50 rows.
- Pipeline assesses each Opportunity. Snapshot independently assesses the Account and lists its visible open Opportunities read-only. Use the Pipeline to change selection.
- A recommendation commits with one explicit submission after any required date or Contact entry. Treat an uncertain outcome as a cue to inspect the refreshed record before trying again. Successful and failed outcomes appear in notifications; cached background refreshes retain the workspace.
- Run the following from the repository root. The tests use mocked Salesforce transport.

```powershell
npm.cmd test
npm.cmd run typecheck
npm.cmd run prettier:verify
npm.cmd run build
powershell.exe -NoProfile -File tests/seed-demo.test.ps1
git diff --check
```

See [architecture, evidence and demo](delivery.md) for the measured baseline and tested accessibility scope.
