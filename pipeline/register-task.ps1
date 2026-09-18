<#
.SYNOPSIS
  Registrira Windows Scheduled Task koji svaki dan pokrece update.ps1.
  Pokreni ovo JEDNOM rucno (kao Administrator ili obican korisnik - Task
  Scheduler po korisniku ne treba admin) da postavis dnevni auto-update.
#>
param(
  [string]$Time = '06:30'
)

$taskName = 'CijeneVode-DnevniUpdate'
$scriptPath = Join-Path $PSScriptRoot 'update.ps1'

# Ukloni stari zadatak posve prije ponovne registracije - Register-ScheduledTask
# -Force zna zadrzati zastarjele postavke iz prijasnje verzije.
Unregister-ScheduledTask -TaskName $taskName -Confirm:$false -ErrorAction SilentlyContinue

$action = New-ScheduledTaskAction -Execute 'powershell.exe' `
  -Argument "-NoProfile -ExecutionPolicy Bypass -File `"$scriptPath`""

$timeParts = $Time -split ':'
$todayAt = (Get-Date).Date.AddHours([int]$timeParts[0]).AddMinutes([int]$timeParts[1])
$startBoundary = if ($todayAt -gt (Get-Date)) { $todayAt } else { $todayAt.AddDays(1) }
$dailyTrigger = New-ScheduledTaskTrigger -Daily -At $startBoundary

# Laptop u 06:30 obicno spava (17.-18.09. je spavao 16:35-08:18), a StartWhenAvailable
# se nakon budjenja u praksi nije okinuo ni jednom. Zato dodatni okidac na
# OTKLJUCAVANJE racunala: cim sjednes za laptop, update.ps1 dohvati sve propustene
# dane. Visestruka pokretanja istog dana su bezopasna - skripta preskace vec
# obradjene datume i status mail salje najvise jednom dnevno.
$unlockTrigger = $null
try {
  $cls = Get-CimClass -Namespace 'ROOT\Microsoft\Windows\TaskScheduler' -ClassName 'MSFT_TaskSessionStateChangeTrigger'
  $unlockTrigger = New-CimInstance -CimClass $cls -ClientOnly -Property @{ StateChange = 8 }  # 8 = SessionUnlock
  $unlockTrigger.UserId = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
} catch {
  Write-Host "Okidac na otkljucavanje nije moguce kreirati: $($_.Exception.Message)" -ForegroundColor Yellow
}

# WakeToRun: probudi laptop iz sna u zadano vrijeme (radi samo ako su "wake timers"
# dopusteni u postavkama napajanja). StartWhenAvailable: ako je propusteno, pokreni
# cim je moguce. Baterija ne blokira pokretanje.
$settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -WakeToRun -DontStopOnIdleEnd `
  -ExecutionTimeLimit (New-TimeSpan -Minutes 30) -MultipleInstances IgnoreNew `
  -DontStopIfGoingOnBatteries -AllowStartIfOnBatteries -Compatibility Win8

$description = 'Svaki dan (i pri otkljucavanju racunala) povlaci sve nove cijene.dev arhive i azurira cijene-vode/app/data.js'
$registered = $false
if ($unlockTrigger) {
  try {
    Register-ScheduledTask -TaskName $taskName -Action $action -Trigger @($dailyTrigger, $unlockTrigger) `
      -Settings $settings -Description $description -ErrorAction Stop | Out-Null
    $registered = $true
    Write-Host "Registriran '$taskName': svaki dan u $Time (sljedece: $startBoundary) + pri svakom otkljucavanju racunala." -ForegroundColor Green
  } catch {
    Write-Host "Registracija s okidacem na otkljucavanje nije uspjela ($($_.Exception.Message)) - registriram samo dnevni okidac." -ForegroundColor Yellow
  }
}
if (-not $registered) {
  Register-ScheduledTask -TaskName $taskName -Action $action -Trigger $dailyTrigger `
    -Settings $settings -Description $description | Out-Null
  Write-Host "Registriran '$taskName': svaki dan u $Time (sljedece: $startBoundary)." -ForegroundColor Green
}
