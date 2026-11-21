$ErrorActionPreference = 'Stop'
$state = @{
    rows = @{}; attempts = 0; writes = 0; failAt = 5; id = 0
}
$owner = '005000000000001AAA'
function sf {
    $global:LASTEXITCODE = 0
    if ($args[0] -eq 'data') {
        $query = $args[3]
        $object = [regex]::Match($query, ' FROM (\w+)').Groups[1].Value
        $records = @(switch ($object) {
            User { @{ Id = $owner; Username = 'rep@example.com' } }
            CurrencyType { if ($query -match "IsoCode = 'EUR'") { @{ IsoCode = 'EUR' } } }
            OpportunityStage { @{ ApiName = 'Prospecting' }; @{ ApiName = 'Qualification' } }
            TaskStatus { @{ ApiName = 'Completed' } }
            TaskPriority { @{ ApiName = 'Normal' } }
            default { if ($state.rows.ContainsKey($object)) { $state.rows[$object] } }
        })
        return @{ status = 0; result = @{ done = $true; totalSize = $records.Count; records = $records } } |
            ConvertTo-Json -Depth 8 -Compress
    }
    if ($args[0] -eq 'sobject' -and $args[1] -eq 'describe') {
        return '{"status":0,"result":{"fields":[{"name":"Role","picklistValues":[{"active":true,"value":"Decision Maker"}]}]}}'
    }
    if ($args[3] -ne '/services/data/v68.0/composite/sobjects' -or $args[5] -ne 'POST' -or $args[7] -ne 'Content-Type: application/json') {
        throw "Unexpected mocked CLI request: $args"
    }
    $body = Get-Content -Raw -LiteralPath $args[9].Substring(1) | ConvertFrom-Json
    if (!$body.allOrNone -or $body.records.Count -gt 150) { throw 'Invalid collection payload.' }
    $state.attempts++
    $saveResults = @(
        foreach ($record in $body.records) {
            $object = $record.attributes.type
            if ($state.attempts -eq $state.failAt) {
                @{ success = $false; errors = @(@{ statusCode = 'TEST_FAILURE'; message = 'Simulated batch rollback' }) }
                continue
            }
            if (!$state.rows.ContainsKey($object)) { $state.rows[$object] = [Collections.Generic.List[object]]::new() }
            if ($object -eq 'Opportunity' -and $record.CurrencyIsoCode -cne 'EUR') { throw 'Missing explicit EUR currency.' }
            $state.id++
            $record | Add-Member -NotePropertyName Id -NotePropertyValue ('a00' + $state.id.ToString('000000000000') + 'AAA')
            if ($object -in 'Task','Opportunity') {
                $record | Add-Member -NotePropertyName IsClosed -NotePropertyValue ($object -eq 'Task')
            }
            $state.rows[$object].Add($record)
            $state.writes++
            @{ success = $true; id = $record.Id }
        }
    )
    ConvertTo-Json -InputObject $saveResults -Depth 8 -Compress
}

$seed = Join-Path $PSScriptRoot '../scripts/seed-demo.ps1'
$options = @{
    TargetOrg = 'offline-test'; OwnerUsername = 'rep@example.com'; AsOf = '2026-11-21'
    DatasetId = [guid]'cc3ba39f-73c7-4842-b2a7-89644f9ae1a0'
}
try {
    & $seed @options -Mode Apply -OpportunityCurrency USD
    throw 'Expected inactive currency to be rejected.'
} catch {
    if ($_ -notmatch 'currency USD is not active') { throw }
}
if ($state.attempts) { throw 'Inactive currency triggered writes.' }
try {
    & $seed @options -Mode Apply
    throw 'Expected the simulated batch failure.'
} catch {
    if ($_ -notmatch 'TEST_FAILURE') { throw }
}
if ($state.rows.Opportunity.Count -ne 300) { throw 'Earlier opportunity batches were expected to remain.' }
& $seed @options -Mode Apply
$expected = @{ Account = 30; Contact = 60; Opportunity = 1080; Task = 30; OpportunityContactRole = 20 }
foreach ($object in $expected.Keys) {
    if ($state.rows[$object].Count -ne $expected[$object]) { throw "Unexpected $object count." }
}
$writes = $state.writes
& $seed @options -Mode Verify
& $seed @options -Mode Apply
if ($state.writes -ne $writes) { throw 'Verify or rerun inserted duplicate records.' }
$state.rows.Opportunity[0].CurrencyIsoCode = 'GBP'
try {
    & $seed @options -Mode Verify
    throw 'Expected a seed currency mismatch.'
} catch {
    if ($_ -notmatch 'unexpected CurrencyIsoCode') { throw }
}
$state.rows.Opportunity[0].CurrencyIsoCode = 'EUR'
$state.rows.Account[0].Description = 'Unrelated or changed account'
try {
    & $seed @options -Mode Apply
    throw 'Expected a seed marker conflict.'
} catch {
    if ($_ -notmatch 'unexpected Description') { throw }
}
if ($state.writes -ne $writes) { throw 'The seed attempted writes after a collision.' }
'Offline seed tests passed: explicit currency, inactive currency guard, currency readback, batch rollback, partial recovery, ownership, rerun and marker collision.'
