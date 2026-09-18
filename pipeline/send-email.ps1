<#
.SYNOPSIS
  Salje mail preko Resend API-ja koristeci pipeline/secrets.json.
#>
param(
  [Parameter(Mandatory=$true)][string]$Subject,
  [Parameter(Mandatory=$true)][string]$Body
)

$ErrorActionPreference = 'Stop'
$secretsPath = Join-Path $PSScriptRoot 'secrets.json'
$secrets = Get-Content $secretsPath -Raw | ConvertFrom-Json

$payload = @{
  from    = $secrets.fromEmail
  to      = @($secrets.toEmail)
  subject = $Subject
  text    = $Body
} | ConvertTo-Json

$headers = @{ Authorization = "Bearer $($secrets.resendApiKey)" }
$resp = Invoke-RestMethod -Uri 'https://api.resend.com/emails' -Method Post `
  -Headers $headers -ContentType 'application/json' -Body $payload
Write-Host "Mail poslan, id: $($resp.id)" -ForegroundColor Green
