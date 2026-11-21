[CmdletBinding()]
param(
    [ValidateSet('Plan','Apply','Verify')][string]$Mode = 'Plan',
    [guid]$DatasetId,
    [string]$AsOf,
    [string]$TargetOrg,
    [string]$OwnerUsername,
    [ValidatePattern('^[A-Za-z]{3}$')][string]$OpportunityCurrency = 'EUR'
)

$ErrorActionPreference = 'Stop'
$OpportunityCurrency = $OpportunityCurrency.ToUpperInvariant()
$accountCount = 30
$opportunitiesPerAccount = 36
if ($Mode -eq 'Plan') {
    Write-Output "30 accounts, 1,080 open opportunities ($OpportunityCurrency), 60 contacts, 30 completed tasks, 20 Decision Maker roles. Expected health at the anchor date: 10 Green, 10 Amber, 10 Red."
    return
}
if (!$DatasetId -or !$TargetOrg -or !$OwnerUsername -or $OwnerUsername -notmatch '^[A-Za-z0-9_.+@-]+$') {
    throw 'Pass -DatasetId, -AsOf, -TargetOrg and the exact Salesforce OAuth username as -OwnerUsername.'
}
$anchor = [DateTime]::ParseExact($AsOf, 'yyyy-MM-dd', [Globalization.CultureInfo]::InvariantCulture)
$namespace = "RW Demo $DatasetId | "
$marker = "rep-workspace-seed:v1:${DatasetId}:${AsOf}|"
$api = '/services/data/v68.0'

function Invoke-SeedQuery([string]$Query) {
    $response = sf data query --query $Query --target-org $TargetOrg --json | ConvertFrom-Json
    if ($LASTEXITCODE -ne 0 -or $response.status -ne 0) { throw "Salesforce seed query failed: $($response.message)" }
    if (!$response.result.done -or $response.result.records.Count -ne $response.result.totalSize) {
        throw 'Seed query returned incomplete results. No further writes will be attempted.'
    }
    return $response.result.records
}

function Add-SeedRecords([string]$Object, [array]$Records) {
    for ($offset = 0; $offset -lt $Records.Count; $offset += 150) {
        $last = [Math]::Min($Records.Count - 1, $offset + 149)
        $batch = @($Records[$offset..$last])
        foreach ($record in $batch) { $record.attributes = @{ type = $Object } }
        $bodyFile = New-TemporaryFile
        try {
            $body = @{ allOrNone = $true; records = $batch } | ConvertTo-Json -Depth 8 -Compress
            [IO.File]::WriteAllText($bodyFile.FullName, $body)
            $raw = sf api request rest "$api/composite/sobjects" --method POST --header 'Content-Type: application/json' --body "@$($bodyFile.FullName)" --target-org $TargetOrg
            if ($LASTEXITCODE -ne 0) { throw "$Object request failed. Rerun with the same dataset settings after checking the error." }
            $parsed = ($raw -join "`n") | ConvertFrom-Json
            $response = @($parsed)
            if ($response.Count -ne $batch.Count) { throw "Unexpected $Object result count. Reconcile using the same dataset settings." }
            $errors = @($response | Where-Object { !$_.success -or !$_.id })
            if ($errors.Count) {
                $messages = $errors.errors | ForEach-Object { "$($_.statusCode): $($_.message)" } | Sort-Object -Unique
                throw "The $Object batch at offset $offset failed. $($messages -join '; ')"
            }
        } finally {
            Remove-Item -LiteralPath $bodyFile.FullName
        }
    }
    if ($Records.Count) { Write-Host "$Object created: $($Records.Count)" }
}

function Sync-Records([string]$Object, [array]$Expected, [scriptblock]$Read, [scriptblock]$Key, [bool]$Recheck = $false) {
    $index = @{}
    foreach ($record in @(& $Read)) {
        $id = & $Key $record
        if ($index.ContainsKey($id)) { throw "Duplicate $Object seed key: $id" }
        $index[$id] = $record
    }
    $missing = @(
        foreach ($entry in $Expected) {
            $id = & $Key $entry
            if (!$index.ContainsKey($id)) { $entry; continue }
            Assert-SeedRecord $Object $entry $index[$id] $id
        }
    )
    if ($missing.Count -and $Mode -eq 'Apply' -and !$Recheck) {
        Add-SeedRecords $Object $missing
        return Sync-Records $Object $Expected $Read $Key $true
    }
    if ($missing.Count) {
        throw "$Object verification failed: $($Expected.Count - $missing.Count) of $($Expected.Count) expected records found."
    }
    Write-Host "$Object verified: $($Expected.Count)"
    return $index
}

function Assert-SeedRecord([string]$Object, [hashtable]$Expected, $Actual, [string]$Id) {
    foreach ($field in 'Description','OwnerId','AccountId','WhatId','OpportunityId','ContactId','Role','ActivityDate','CloseDate','CurrencyIsoCode') {
        if ($Expected.ContainsKey($field) -and $Expected[$field] -cne $Actual.$field) {
            throw "$Object seed key $Id has an unexpected $field. Existing records will not be changed."
        }
    }
    if ($Object -eq 'Opportunity' -and $Actual.IsClosed -ne $false) { throw "Seed opportunity $Id is closed." }
    if ($Object -eq 'Task' -and $Actual.IsClosed -ne $true) { throw "Seed task $Id is open." }
}

$owners = @(Invoke-SeedQuery "SELECT Id, Username FROM User WHERE IsActive = true AND Username = '$OwnerUsername'")
if ($owners.Count -ne 1) { throw 'The requested OAuth owner is not an active Salesforce user in this org.' }
$owner = $owners[0].Id
$currencies = @(Invoke-SeedQuery "SELECT IsoCode FROM CurrencyType WHERE IsActive = true AND IsoCode = '$OpportunityCurrency'")
if ($currencies.Count -ne 1 -or $currencies[0].IsoCode -cne $OpportunityCurrency) {
    throw "Opportunity currency $OpportunityCurrency is not active in the target org."
}
$stages = @(Invoke-SeedQuery 'SELECT ApiName FROM OpportunityStage WHERE IsActive = true AND IsClosed = false ORDER BY SortOrder')
$statuses = @(Invoke-SeedQuery 'SELECT ApiName FROM TaskStatus WHERE IsClosed = true ORDER BY SortOrder LIMIT 1')
$priorities = @(Invoke-SeedQuery 'SELECT ApiName FROM TaskPriority ORDER BY SortOrder LIMIT 1')
if (!$stages.Count -or !$statuses.Count -or !$priorities.Count) { throw 'The org requires valid stage, closed task status and task priority values.' }
$describe = sf sobject describe --sobject OpportunityContactRole --target-org $TargetOrg --json | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $describe.status -ne 0) { throw 'Could not verify the Opportunity Contact Role picklist.' }
$roleField = $describe.result.fields | Where-Object { $_.name -eq 'Role' }
if (-not ($roleField.picklistValues | Where-Object { $_.active -and $_.value -ceq 'Decision Maker' })) {
    throw 'The active Opportunity Contact Role API value Decision Maker is required.'
}

$company = @('Alder Logistics','Brightline Energy','Cobalt Payments','Dunefield Foods','Evergreen Health','Forge Materials','Granite Transit','Harbor Networks','Ironwood Supply','Juniper Media','Keystone Labs','Lakeshore Manufacturing','Meridian Software','Northstar Aviation','Oakwell Insurance','Pioneer Packaging','Quarry Telecom','Redwood Retail','Summit Diagnostics','Tandem Mobility','Union Robotics','Vale Industries','Westbridge Security','Yarrow Systems','Zenith Freight','Arcstone Financial','Bluewater Marine','Cedar Education','Driftwood Hotels','Elmstone Services')
$projects = @('Renewal','Field expansion','Platform rollout','Analytics pilot','Service upgrade','Regional launch')
$firstNames = @('Sam','Alex','Taylor','Morgan','Riley','Casey')
$lastNames = @('Chen','Silva','Patel','Keller','Martin','Okafor')

$accounts = Sync-Records Account @(
    foreach ($name in $company) { @{ Name = $namespace + $name; Description = $marker + 'Account|' + $name; OwnerId = $owner } }
) { Invoke-SeedQuery "SELECT Id, Name, Description, OwnerId FROM Account WHERE Name LIKE '${namespace}%'" } { param($row) $row.Name }
$ids = ($company | ForEach-Object { "'" + $accounts[$namespace + $_].Id + "'" }) -join ','

$contacts = [Collections.Generic.List[hashtable]]::new()
$opportunities = [Collections.Generic.List[hashtable]]::new()
$tasks = [Collections.Generic.List[hashtable]]::new()
$roles = [Collections.Generic.List[hashtable]]::new()
for ($i = 0; $i -lt $accountCount; $i++) {
    $name = $company[$i]
    $accountId = $accounts[$namespace + $name].Id
    $group = $i % 3
    for ($j = 0; $j -lt 2; $j++) {
        $last = $lastNames[($i + $j) % $lastNames.Count]
        $contacts.Add(@{ AccountId = $accountId; OwnerId = $owner; FirstName = $firstNames[($i + $j) % $firstNames.Count]
            LastName = $last; Title = @('Head of Operations','Procurement Manager')[$j]; Description = "${marker}Contact|$name|$j" })
        if ($j -eq 0 -and $group -ne 1) {
            $roles.Add(@{ ContactKey = "$accountId|$last"; OpportunityKey = "$accountId|$name - $($projects[0]) 01" })
        }
    }
    for ($j = 0; $j -lt $opportunitiesPerAccount; $j++) {
        $dateOffset = @(14, 2, -5)[$group] + $j
        $label = "$name - $($projects[$j % $projects.Count]) $(($j + 1).ToString('00'))"
        $opportunities.Add(@{ AccountId = $accountId; OwnerId = $owner; Name = $label; Amount = 8000 + (($i * 13 + $j * 31) % 250) * 850
            CurrencyIsoCode = $OpportunityCurrency
            Description = "${marker}Opportunity|$name|$j"; StageName = $stages[$j % $stages.Count].ApiName
            CloseDate = $anchor.AddDays($dateOffset).ToString('yyyy-MM-dd') })
    }
    $tasks.Add(@{ WhatId = $accountId; OwnerId = $owner; Subject = 'Discovery call'; Status = $statuses[0].ApiName
        Priority = $priorities[0].ApiName; Description = "${marker}Task|$name"; ActivityDate = $anchor.AddDays(@(-3, -8, -29)[$group]).ToString('yyyy-MM-dd') })
}
$contactIndex = Sync-Records Contact $contacts.ToArray() {
    Invoke-SeedQuery "SELECT Id, AccountId, OwnerId, LastName, Description FROM Contact WHERE AccountId IN ($ids)"
} { param($row) "$($row.AccountId)|$($row.LastName)" }
$opportunityIndex = Sync-Records Opportunity $opportunities.ToArray() {
    Invoke-SeedQuery "SELECT Id, AccountId, OwnerId, Name, Description, CloseDate, IsClosed, CurrencyIsoCode FROM Opportunity WHERE AccountId IN ($ids)"
} { param($row) "$($row.AccountId)|$($row.Name)" }
$null = Sync-Records Task $tasks.ToArray() {
    Invoke-SeedQuery "SELECT Id, WhatId, OwnerId, Subject, Description, ActivityDate, IsClosed FROM Task WHERE WhatId IN ($ids) AND Subject = 'Discovery call'"
} { param($row) $row.WhatId }

$expectedRoles = @(
    foreach ($role in $roles) {
        @{ OpportunityId = $opportunityIndex[$role.OpportunityKey].Id; ContactId = $contactIndex[$role.ContactKey].Id; Role = 'Decision Maker' }
    }
)
$roleIds = ($expectedRoles | ForEach-Object { "'" + $_.OpportunityId + "'" }) -join ','
$null = Sync-Records OpportunityContactRole $expectedRoles {
    Invoke-SeedQuery "SELECT Id, OpportunityId, ContactId, Role FROM OpportunityContactRole WHERE OpportunityId IN ($roleIds)"
} { param($row) "$($row.OpportunityId)|$($row.ContactId)" }
Write-Output "Dataset $DatasetId verified for $($owners[0].Username): 30 accounts, 1080 open $OpportunityCurrency opportunities, 60 contacts, 30 completed tasks, 20 roles."
