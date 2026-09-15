param(
    [Parameter(Mandatory)][string]$Source,
    [string]$OutputDocx,
    [string]$OutputPdf
)

$ErrorActionPreference = 'Stop'
$sourceDirectory = Split-Path -Parent $Source
$sourceName = [System.IO.Path]::GetFileNameWithoutExtension($Source)
if (-not $OutputDocx) { $OutputDocx = Join-Path $sourceDirectory "${sourceName}_IEEE_Final.docx" }
if (-not $OutputPdf) { $OutputPdf = Join-Path $sourceDirectory "${sourceName}_IEEE_Final.pdf" }

function Set-ParagraphText {
    param(
        [Parameter(Mandatory)]$Document,
        [Parameter(Mandatory)][string]$Match,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Text
    )

    foreach ($paragraph in $Document.Paragraphs) {
        $current = ($paragraph.Range.Text -replace '[\r\a]', '').Trim()
        if ($current -like "*$Match*") {
            $range = $paragraph.Range
            $range.End = $range.End - 1
            $range.Text = $Text
            return
        }
    }
    throw "Could not find manuscript paragraph containing: $Match"
}

function Set-CellText {
    param(
        [Parameter(Mandatory)]$Table,
        [Parameter(Mandatory)][int]$Row,
        [Parameter(Mandatory)][int]$Column,
        [Parameter(Mandatory)][string]$Text
    )

    $Table.Cell($Row, $Column).Range.Text = $Text
}

function Add-TableCaption {
    param(
        [Parameter(Mandatory)]$Table,
        [Parameter(Mandatory)][string]$Number,
        [Parameter(Mandatory)][string]$Title
    )

    $firstDataRow = $Table.Rows.Item(1)
    $null = $Table.Rows.Add($firstDataRow)
    $null = $Table.Rows.Add($firstDataRow)
    $Table.Rows.Item(1).Cells.Merge()
    $Table.Rows.Item(2).Cells.Merge()
    $Table.Cell(1, 1).Range.Text = "TABLE $Number"
    $Table.Cell(2, 1).Range.Text = $Title
    $Table.Rows.Item(1).Range.ParagraphFormat.Alignment = 1
    $Table.Rows.Item(2).Range.ParagraphFormat.Alignment = 1
    $Table.Rows.Item(1).Range.Font.Bold = $false
    $Table.Rows.Item(2).Range.Font.Bold = $false
}

function Set-IeeeTableStyle {
    param([Parameter(Mandatory)]$Table)

    $Table.Range.Font.Name = 'Times New Roman'
    $Table.Range.Font.Size = 8
    $Table.Range.ParagraphFormat.SpaceAfter = 0
    $Table.Range.ParagraphFormat.SpaceBefore = 0
    $Table.Shading.BackgroundPatternColor = 16777215
    foreach ($border in $Table.Borders) { $border.LineStyle = 0 }
    $headerRow = if (($Table.Cell(1, 1).Range.Text -replace '[\r\a]', '').Trim() -like 'TABLE *') { 3 } else { 1 }
    $Table.Rows.Item($headerRow).Range.Font.Bold = $true
    $Table.Rows.Item($headerRow).HeadingFormat = -1
    $Table.Rows.Item($headerRow).Borders.Item(-1).LineStyle = 1
    $Table.Rows.Item($headerRow).Borders.Item(-3).LineStyle = 1
    $Table.Borders.Item(-3).LineStyle = 1
}

function Replace-InlineSvg {
    param(
        [Parameter(Mandatory)]$Document,
        [Parameter(Mandatory)][int]$Index,
        [Parameter(Mandatory)][string]$Path
    )

    $shape = $Document.InlineShapes.Item($Index)
    $width = $shape.Width
    $range = $shape.Range.Duplicate
    $shape.Delete()
    $replacement = $Document.InlineShapes.AddPicture($Path, $false, $true, $range)
    $replacement.LockAspectRatio = -1
    $replacement.Width = $width
}

$word = $null
$document = $null
try {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $false
    $word.DisplayAlerts = 0
    $document = $word.Documents.Open($Source, $false, $true)

    Set-ParagraphText $document 'Arnav Gupta' 'Arnav Gupta (ORCID: 0009-0000-5234-1331)'
    Set-ParagraphText $document 'Vellore Institute of Technology Chennai India' 'Vellore Institute of Technology, Chennai, India'

    Set-ParagraphText $document 'The same device and action sent twice within the same second' 'The same device and action sent twice within the same second produces the same identifier, even if ECDSA generates different signature bytes. This behavior rejects exact semantic duplicates but also prevents two legitimate identical actions in one second. Before higher-rate deployment, future work will add a cryptographically random nonce and millisecond-resolution timestamp to the canonical signed request envelope and replay identifier, together with a canonical request-body digest. This change will prevent avoidable second-level request-ID collisions while preserving atomic duplicate detection.'

    $ledgerSet = [char]0x2112
    Set-ParagraphText $document 'For ledger L in' "For ledger L in the set $ledgerSet = {F, I}, the state is s_L(id) in {ACTIVE, REVOKED, absent}, with version v_L(id). A request carries the device identifier id, action a, Unix timestamp t, and ECDSA signature sigma. The canonical signed message is:"

    Set-ParagraphText $document 'Mutation authorization is intentionally described as implemented' 'Mutation authorization is intentionally described as implemented: the chaincode hard-codes Org1MSP as the only permitted membership service provider and additionally requires an administrator organizational unit in the invoker certificate. This is a single-organization authorization rule, not multi-organization governance; an Org2 administrator cannot authorize a mutation under this check. The channel-level endorsement policy may require endorsements from both organizations, but endorsement does not replace an explicit multi-organization authorization decision. Future work will replace the Org1MSP constant with a reviewed, configurable consortium policy that defines participating organizations, administrator attributes, and the required approval quorum, followed by adversarial policy tests and performance re-evaluation.'

    Set-ParagraphText $document 'The implementation checks C before the final A branch' 'The implementation intentionally claims C before the final A branch. A correctly signed request from a revoked device is an authenticated security event, so the durable claim records it once and prevents repeated copies of the same signed tuple from creating duplicate audit events. The request still returns HTTP 403 and can never reach the grant branch. This audit-first ordering consumes the replay identifier; deployments that require retryable revoked requests must move the revocation check before C and persist a separate non-unique denial event.'

    Set-ParagraphText $document 'Clocks: End-to-end latency was measured' 'Clocks: All latency values reported here are elapsed durations measured with Node.js process.hrtime.bigint(), a monotonic high-resolution clock: the load generator measured HTTP endpoint latency and the gateway measured synchronized registration stages. No reported value is computed by subtracting timestamps captured on different hosts or containers. During final inspection, midpoint-corrected probes placed the Docker/Fabric clock approximately 107 ms ahead of Windows on average and WSL approximately 46 ms ahead, but the Windows Time service remained stopped and could not be enabled without administrator privileges. Therefore, this paper does not report cross-host commit-to-visibility latency. Such measurements remain future work and require an actively synchronized host clock, pre-run and post-run skew checks, and a stated uncertainty bound.'

    Set-ParagraphText $document 'A valid IOTA lifecycle distribution was not obtained' 'The IOTA lifecycle evaluation comprised eight measured runs of 20 iterations each. It produced 160 successful observations for every operation. Registration succeeded in 160 of 161 total attempts; one earlier registration returned HTTP 500 after 1,630.0 ms and is retained in the raw data but excluded from successful-latency statistics. Successful-operation median and p95 latencies were 2,390.4 and 4,378.5 ms for registration, 2,910.3 and 4,101.2 ms for revocation, 2,861.2 and 4,669.0 ms for activation, 2,849.2 and 4,695.2 ms for key rotation, and 2,314.4 and 4,365.8 ms for deletion. Thus, key rotation had the highest observed IOTA lifecycle p95.'

    Set-ParagraphText $document 'Synchronized registration stage timings from Equation 6 were not instrumented' 'Synchronized registration stage timings from Equation 6 were instrumented in the gateway with process.hrtime.bigint() around each sequential stage. Across 42 successful registrations, p95 durations were 2,079.1 ms for Fabric, 3,912.1 ms for IOTA, 371.4 ms for PostgreSQL projection, 3.8 ms for simulator-key persistence, and 6,095.2 ms for the total sequential commit chain. Successful end-to-end endpoint latency had a p95 of 6,199.5 ms. Three failed endpoint attempts are retained in the raw data but excluded from these successful-latency statistics. Because all stage durations use the gateway process clock, they are not cross-host commit-to-visibility measurements. One mocked failure-injection control rejected the IOTA commit after a successful Fabric commit; Fabric deletion compensation succeeded and no mocked residual divergence remained. This control establishes rollback behavior only, not real-ledger compensation latency or consistency.'

    Set-ParagraphText $document 'Authorization latency begins immediately before the client sends' 'Authorization latency begins immediately before the client sends the HTTP request and ends after the complete response. The revised gateway also measures three server-side components with process.hrtime.bigint(): ledgerLookupMs around the authoritative device lookup, replayAuditPersistenceMs around the atomic replay claim and audit insertion, and gatewayTotalMs around the complete handler. The benchmark exports these fields per request and the analyzer reports them by route and concurrency. The archived authorization runs predate this instrumentation, so their component values cannot be reconstructed and are not presented as measured results. Lifecycle operations measure HTTP completion; synchronized registration separately measures the Fabric, IOTA, PostgreSQL, and key-persistence stages.'

    Set-ParagraphText $document 'Fabric first reached saturation at concurrency 2' 'Fabric first reached saturation at concurrency 2: throughput peaked at 16.44 requests/s and did not increase at concurrency 4 or 8, while p95 latency increased from 260.1 to 602.2 and 1,094.0 ms. IOTA showed its first saturation indication between concurrency 2 and 4, where throughput fell from 3.60 to 3.28 requests/s while p95 latency more than doubled. PostgreSQL did not reach a clear throughput plateau by concurrency 8. The production rate limiter was raised to 10,000,000 requests per window and did not cause the observed saturation. All routes included PostgreSQL audit and replay persistence. Fabric used a local Docker peer, PostgreSQL used the remote Supabase data path, and IOTA used uncached getObject requests against a shared public-testnet endpoint. Because the archived runs did not separate authoritative lookup from replay and audit persistence, saturation cannot be attributed quantitatively to either component. The revised harness now exports ledgerLookupMs, replayAuditPersistenceMs, and gatewayTotalMs so future repeated runs can test that attribution without estimating it from end-to-end latency.'

    Set-ParagraphText $document 'Priorities for the next implementation are a canonical request envelope' 'Priorities for the next implementation are a canonical signed request envelope with a cryptographically random nonce, millisecond-resolution timestamp, and body hash; durable versioned state on both ledgers; periodic divergence detection and reconciliation; distributed rate limiting; hardware-backed gateway and device keys; and multi-organization Fabric governance that replaces the hard-coded Org1MSP authorization rule with an explicit consortium approval policy. Additional priorities are privacy-preserving device pseudonyms and real-device measurements. Cross-ledger anchoring or a formally specified coordinator should be added only if the research question requires stronger consistency than selectable authority.'

    Set-ParagraphText $document 'AI Use Disclosure:' ''
    Set-ParagraphText $document 'The author thanks Prof. Kiran Kumar' 'The author thanks Prof. Kiran Kumar for guidance and technical feedback and Vellore Institute of Technology Chennai for academic support. OpenAI ChatGPT assisted with language editing, document formatting, and code-review suggestions. The author independently verified all technical content, experiments, results, references, and final wording.'

    Set-ParagraphText $document 'RESULT SUMMARY TO COMPLETE FROM RELEASED RAW DATA' "TABLE IX`vRESULT SUMMARY FROM RELEASED RAW DATA"

    $oldTimingTable = $document.Tables.Item(5)
    $timingRange = $oldTimingTable.Range.Duplicate
    $oldTimingTable.Delete()
    $timingTable = $document.Tables.Add($timingRange, 7, 5)
    $timingRows = @(
        @('Stage', 'n', 'Mean, ms', 'Median, ms', 'p95, ms'),
        @('T_F', '42', '2051.4', '2037.6', '2079.1'),
        @('T_I', '42', '2092.9', '1747.4', '3912.1'),
        @('T_P', '42', '149.9', '90.2', '371.4'),
        @('T_K', '42', '3.0', '2.9', '3.8'),
        @('T_total', '42', '4297.2', '3884.6', '6095.2'),
        @('Endpoint', '42', '4407.5', '3993.3', '6199.5')
    )
    for ($row = 0; $row -lt $timingRows.Count; $row++) {
        for ($column = 0; $column -lt $timingRows[$row].Count; $column++) {
            Set-CellText $timingTable (1 + $row) (1 + $column) $timingRows[$row][$column]
        }
    }

    $oldAuthorizationTable = $document.Tables.Item(6)
    $authorizationRange = $oldAuthorizationTable.Range.Duplicate
    $oldAuthorizationTable.Delete()
    $authorizationTable = $document.Tables.Add($authorizationRange, 13, 5)
    $authorizationRows = @(
        @('Route', 'c', 'Median, ms', 'p95, ms', 'Throughput, req/s'),
        @('Fabric', '1', '66.7', '187.5', '12.02'),
        @('Fabric', '2', '102.0', '260.1', '16.44'),
        @('Fabric', '4', '237.3', '602.2', '14.99'),
        @('Fabric', '8', '469.7', '1094.0', '15.04'),
        @('IOTA', '1', '290.7', '676.1', '2.80'),
        @('IOTA', '2', '530.9', '868.8', '3.60'),
        @('IOTA', '4', '1123.1', '1869.7', '3.28'),
        @('IOTA', '8', '1793.5', '2010.9', '4.41'),
        @('PostgreSQL', '1', '103.4', '172.3', '8.81'),
        @('PostgreSQL', '2', '139.7', '264.1', '13.14'),
        @('PostgreSQL', '4', '208.0', '402.8', '16.84'),
        @('PostgreSQL', '8', '397.1', '716.6', '18.23')
    )
    for ($row = 0; $row -lt $authorizationRows.Count; $row++) {
        for ($column = 0; $column -lt $authorizationRows[$row].Count; $column++) {
            Set-CellText $authorizationTable (1 + $row) (1 + $column) $authorizationRows[$row][$column]
        }
    }

    $lifecycleTable = $document.Tables.Item(7)
    $insertBefore = $lifecycleTable.Rows.Item(7)
    1..5 | ForEach-Object { $null = $lifecycleTable.Rows.Add($insertBefore) }
    $iotaRows = @(
        @('IOTA', 'Register', '2,390.4', '4,378.5', '160/161'),
        @('IOTA', 'Revoke', '2,910.3', '4,101.2', '160/160'),
        @('IOTA', 'Activate', '2,861.2', '4,669.0', '160/160'),
        @('IOTA', 'Rotate', '2,849.2', '4,695.2', '160/160'),
        @('IOTA', 'Delete', '2,314.4', '4,365.8', '160/160')
    )
    for ($index = 0; $index -lt $iotaRows.Count; $index++) {
        for ($column = 0; $column -lt 5; $column++) {
            Set-CellText $lifecycleTable (7 + $index) (1 + $column) $iotaRows[$index][$column]
        }
    }

    $summaryTable = $document.Tables.Item(9)
    Set-CellText $summaryTable 4 4 '4378.48 ms*'

    $schemaTable = $document.Tables.Item(4)
    Set-CellText $schemaTable 2 2 'runId; experiment; backend; phase; concurrency; completedAt; latencyMs; ledgerLookupMs; replayAuditPersistenceMs; gatewayTotalMs; statusCode; success'

    Set-ParagraphText $document 'TABLE V' ''
    Add-TableCaption $document.Tables.Item(5) 'V' 'SYNCHRONIZED REGISTRATION STAGE LATENCY (MS)'
    Add-TableCaption $document.Tables.Item(6) 'VI' 'AUTHORIZATION LATENCY AND THROUGHPUT BY ROUTE AND CONCURRENCY'
    Add-TableCaption $document.Tables.Item(7) 'VII' 'DEVICE LIFECYCLE ENDPOINT LATENCY'
    Add-TableCaption $document.Tables.Item(8) 'VIII' 'MEASURED HOST RESOURCE UTILIZATION'

    foreach ($table in $document.Tables) { Set-IeeeTableStyle $table }

    Replace-InlineSvg $document 7 (Join-Path $PSScriptRoot '..\docs\dual-ledger-registration.svg')
    Replace-InlineSvg $document 6 (Join-Path $PSScriptRoot '..\docs\access-request-sequence.svg')
    Replace-InlineSvg $document 2 (Join-Path $PSScriptRoot '..\docs\equation-request-message.svg')
    Replace-InlineSvg $document 1 (Join-Path $PSScriptRoot '..\docs\architecture.svg')

    $document.SaveAs2($OutputDocx, 16)
    $document.ExportAsFixedFormat($OutputPdf, 17)
}
finally {
    if ($null -ne $document) { $document.Close($false) }
    if ($null -ne $word) { $word.Quit() }
}

Write-Output "Created $OutputDocx"
Write-Output "Created $OutputPdf"
