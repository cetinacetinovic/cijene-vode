<#
.SYNOPSIS
  Povlaci novu dnevnu arhivu s cijene.dev i spaja je u app/data.js.

.DESCRIPTION
  Cita postojeci app/data.js (window.WATER_DATA), nalazi najnoviju dostupnu
  arhivu noviju od zadnjeg poznatog datuma (ili konkretan -Date), preuzima
  zip, filtrira artikle vode po lancu, agregira cijene po (lanac, artikl) za
  taj dan i dopisuje novi red u dates/obs. products.csv/prices.csv format je
  dokumentiran na https://cijene.dev/docs (v0 arhive, bez autentifikacije).

.PARAMETER Date
  Konkretan datum arhive (yyyy-MM-dd) za obradu. Ako je izostavljen, obradjuju
  se redom SVE arhive novije od zadnjeg datuma u data.js, plus ponovno oni
  nedavni dani cija je arhiva u medjuvremenu azurirana (vidi -Replace).

.PARAMETER Replace
  Uz -Date: datum koji je vec u data.js obradi ponovno i zamijeni mu zapise.
  cijene.dev ujutro objavi nepotpunu arhivu dana (fale neki lanci), a konacnu
  tek navecer oko 21:40.
#>
param(
  [string]$Date,
  [switch]$Replace
)

$ErrorActionPreference = 'Stop'
# Invoke-WebRequest-ov progress bar je u Windows PowerShell 5.1 poznato spor na velikim
# fajlovima (moze peglati CPU bez ikakvog stvarnog napretka preuzimanja) - iskljuci ga.
$ProgressPreference = 'SilentlyContinue'
$root = Split-Path -Parent $PSScriptRoot
$dataPath = Join-Path $root 'app\data.js'
$tempDir = Join-Path $env:TEMP ("cijene-update-" + [guid]::NewGuid().ToString('N'))
$secretsPath = Join-Path $root 'pipeline\secrets.json'

# Salje jedan status mail dnevno preko Resend-a (pipeline/secrets.json) - poziva se
# na svakom izlazu iz skripte, tako da svaki dan stigne mail bez obzira je li bilo
# promjene, nove arhive jos nema, ili je arhiva vec ranije obradjena.
function Send-StatusEmail([string]$Subject, [string]$Html) {
  # U GitHub Actions kljuc stize kroz repo Secrets kao varijable okruzenja;
  # lokalno iz pipeline/secrets.json (koji se nikad ne commita).
  if ($env:RESEND_API_KEY) {
    $apiKey = $env:RESEND_API_KEY; $from = $env:MAIL_FROM; $to = $env:MAIL_TO
  } elseif (Test-Path $secretsPath) {
    $secrets = Get-Content $secretsPath -Raw | ConvertFrom-Json
    $apiKey = $secrets.resendApiKey; $from = $secrets.fromEmail; $to = $secrets.toEmail
  } else { return }
  try {
    $payload = @{ from = $from; to = @($to); subject = $Subject; html = $Html } | ConvertTo-Json -Depth 5
    Invoke-RestMethod -Uri 'https://api.resend.com/emails' -Method Post `
      -Headers @{ Authorization = "Bearer $apiKey" } -ContentType 'application/json' -Body $payload | Out-Null
    Write-Host "Status mail poslan." -ForegroundColor Green
  } catch {
    Write-Host "Slanje maila nije uspjelo: $($_.Exception.Message)" -ForegroundColor Yellow
  }
}
function BigDateHeader([string]$dateStr) {
  "<div style='font-family:Arial,sans-serif;font-size:32px;font-weight:700;margin-bottom:10px;'>$dateStr</div>"
}

# Cijene ispod/iznad ovoga nisu vjerodostojna cijena boce vode (isto ogranicenje kao u app.js).
$OUTLIER_FLOOR = 0.25
$OUTLIER_CAP = 10.0

# Flat 10 EUR cap hvata samo najekstremnije greske (npr. cijela paleta upisana kao
# cijena komada). Manju verziju iste greske - Metro Cetina 0,5l po 3,68 EUR umjesto
# ~0,60 EUR - ne hvata jer je ispod 10. Skalira cap prema STVARNOJ kolicini koju
# TA KONKRETNA stavka pokriva.
#
# Prvi pokusaj (samo iz naziva) je bio pogresan za veletrgovce poput Metroa: isti
# naziv "1,0L JANA VODA PET" tamo postoji kao VISE razlicitih stavki - jedna za
# pojedinacnu bocu (qty="1 L"), druga za veleprodajno pakiranje od 6 komada
# (qty="6 L", sto je UKUPNA kolicina, ne 6 litara jedne boce). Naziv uvijek kaze
# "1,0L" bez obzira koja je stavka u pitanju, pa je naziv sam po sebi nepouzdan -
# polje kolicine (qty) je pouzdaniji signal KOLIKO ta konkretna stavka pokriva,
# kad izgleda kao volumen (sadrzi "l"/"ml", ili je unit stupac "L"/"LT"). Kad qty
# ne izgleda kao volumen (npr. unit="KOM" = broj komada), qty se ignorira i koristi
# se samo velicina iz naziva - to je slucaj kod vecine klasicnih trgovackih lanaca.
function Get-OutlierCap([string]$name, [string]$qty, [string]$unit) {
  $n = if ($name) { $name } else { '' }
  $nameLiters = $null
  if ($n -match '(\d+(?:[.,]\d+)?)\s*(ml|l)\b') {
    $val = [double]::Parse(($Matches[1] -replace ',', '.'), [System.Globalization.CultureInfo]::InvariantCulture)
    if ($Matches[2] -eq 'ml') { $val = $val / 1000 }
    if ($val -gt 0 -and $val -lt 50) { $nameLiters = $val }
  }
  $totalLiters = $nameLiters
  if ($qty) {
    $qtyLooksVolume = ($qty -match '(?i)\bm?l\b') -or ($unit -match '(?i)^lt?$')
    if ($qtyLooksVolume -and $qty -match '(\d*[.,]\d+|\d+)') {
      $val = [double]::Parse(($Matches[1] -replace ',', '.'), [System.Globalization.CultureInfo]::InvariantCulture)
      if ($qty -match '(?i)\bml\b') { $val = $val / 1000 }
      if ($val -gt 0 -and $val -lt 1000 -and ($null -eq $totalLiters -or $val -gt $totalLiters)) { $totalLiters = $val }
    }
  }
  if ($null -eq $totalLiters) { return $OUTLIER_CAP }
  return [math]::Min($OUTLIER_CAP, [math]::Max(2.5, $totalLiters * 3.5))
}

# Isti "je li ovo uopce voda" filter kao klijentska inferWtype() logika u app.js,
# da se u PRODUCTS ne uvuku kozmetika/kemija koje sadrze rijec "voda".
$NON_WATER_NOISE = 'povodac|ambal|odcep|odvod|pistolj|casa|case|micel|micer|termaln|uriage|garnier|violeta|tesori|duopack|slag|toaletn|kolonjsk|zubn|dolcela|oral b|gillette|balea|byphasse|eveline|nivea|ziaja|avene|simple|mixa|ulje|iliada|parf'
$NON_WATER_PHRASES = 'voda za usta|voda/usta|voda za ispiranje|vodaza|mic\.voda|micel\.voda'

function Strip-Diacritics([string]$s) {
  if (-not $s) { return '' }
  $normalized = $s.Normalize([System.Text.NormalizationForm]::FormD)
  $sb = New-Object System.Text.StringBuilder
  foreach ($ch in $normalized.ToCharArray()) {
    $cat = [System.Globalization.CharUnicodeInfo]::GetUnicodeCategory($ch)
    if ($cat -ne [System.Globalization.UnicodeCategory]::NonSpacingMark) {
      [void]$sb.Append($ch)
    }
  }
  return $sb.ToString().ToLowerInvariant()
}

function Is-WaterProduct([string]$name) {
  $n = Strip-Diacritics $name
  if ($n -notmatch '\bvoda\b') { return $false }
  if ($n -match $NON_WATER_NOISE) { return $false }
  if ($n -match $NON_WATER_PHRASES) { return $false }
  return $true
}

# Ista klasifikacija kao klijentska inferWtype() u app.js - koristi se da mail o
# promjeni cijena prati samo gaziranu/negaziranu vodu, bez aromatiziranih (previse
# artikala i nije ono sto korisnika zanima).
$FLAVOR_WORDS = 'limun|limet|malin|jagod|guav|kupin|marakuj|mango|brusnic|borovnic|ment|kokos|naranc|narandz|breskv|kivano|kiwano|dunj|krus|ribiz|jabuk|dumbir|bazg|vanilij|lubenic|antiox|detox|kolagen|collagen|immuno|focus|antistres|refresh|optimist|energy|happy|arom|sens|sen\.|tonic|vit'
function Get-EffectiveWtype([string]$storedWtype, [string]$name) {
  if ($storedWtype -ne 'nepoznato') { return $storedWtype }
  $n = Strip-Diacritics $name
  if ($n -notmatch '\bvoda\b') { return $storedWtype }
  if ($n -match $NON_WATER_NOISE -or $n -match $NON_WATER_PHRASES) { return $storedWtype }
  if ($n -match 'negazir') { return 'negazirana' }
  if ($n -match '\bgazir') { return 'gazirana' }
  if ($n -match $FLAVOR_WORDS) { return 'aromatizirana' }
  return 'negazirana'
}

Write-Host "== Ucitavanje postojeceg data.js ==" -ForegroundColor Cyan
$raw = [System.IO.File]::ReadAllText($dataPath)
$jsonStart = $raw.IndexOf('{')
$jsonEnd = $raw.LastIndexOf('}')
$json = $raw.Substring($jsonStart, $jsonEnd - $jsonStart + 1)
$WATER = $json | ConvertFrom-Json

$dates = [System.Collections.Generic.List[string]]::new([string[]]$WATER.dates)
$chains = [System.Collections.Generic.List[string]]::new([string[]]$WATER.chains)
# products/obs su nizovi nizova (arrays of arrays) - drzimo ih kao ArrayList radi laganog dodavanja
$products = [System.Collections.ArrayList]::new()
foreach ($p in $WATER.products) { [void]$products.Add(@($p)) }
$obs = [System.Collections.ArrayList]::new()
foreach ($o in $WATER.obs) { [void]$obs.Add(@($o)) }

# -Replace: izbaci postojece zapise tog datuma prije svega ostalog, da i detekcija
# promjena cijena usporedjuje s danom PRIJE njega, a ne s njegovom nepotpunom verzijom.
$replaceIdx = -1
if ($Replace -and $Date -and $dates.Contains($Date)) {
  $replaceIdx = $dates.IndexOf($Date)
  $kept = [System.Collections.ArrayList]::new()
  foreach ($o in $obs) { if ($o[0] -ne $replaceIdx) { [void]$kept.Add($o) } }
  Write-Host "Zamjenjujem postojece zapise za $Date ($($obs.Count - $kept.Count) redaka)." -ForegroundColor Cyan
  $obs = $kept
}

# Koju je verziju (polje "updated") svake arhive pipeline zadnji put obradio -
# po tome se prepozna da je cijene.dev u medjuvremenu objavio potpuniju verziju.
$stampPath = Join-Path $root 'pipeline\processed-archives.json'
$stamps = @{}
if (Test-Path $stampPath) {
  (Get-Content $stampPath -Raw | ConvertFrom-Json).PSObject.Properties | ForEach-Object { $stamps[$_.Name] = [string]$_.Value }
}

# index (chain|name|qty) -> product index, za spajanje s postojecim artiklima.
# Kolicina (qty) mora biti dio kljuca - Metro ima DVA razlicita product_id-a pod
# doslovno istim nazivom "0,5L CETINA VODA PET" (jedan 0,5 l po 0,61 EUR, drugi -
# vjerojatno 6-pack/3 l ukupno - po 3,68 EUR), razlikuju se samo u polju kolicine.
# Bez qty u kljucu ova dva artikla se spoje u jedan prodIdx i naizmjenicno pisu
# 0,61/3,68 kao "istu" cijenu istog dana - upravo lazna "promjena" koju je korisnik
# prijavio.
$productIndex = @{}
for ($i = 0; $i -lt $products.Count; $i++) {
  $key = $products[$i][0] + '|' + $products[$i][1] + '|' + $products[$i][3]
  $productIndex[$key] = $i
}

# prodIdx -> zadnja poznata NAJNIZA cijena PRIJE ovog pokretanja (za detekciju
# promjena cijena). Zlatno pravilo: prati se najniza cijena dana (min preko svih
# poslovnica), ne prosjek - jedan pogresan unos u jednoj poslovnici (npr. Metro
# Cetina 0,5l odjednom po 3,68 EUR umjesto ~0,60) zna izoblici prosjek i
# napraviti laznu "promjenu", dok najniza cijena ostaje netaknuta osim ako se
# STVARNO svugdje podigne. Isti OUTLIER_FLOOR/velicinski cap kao pri agregaciji:
# postojeci obs zna sadrzavati stare izvan-raspona vrijednosti koje app.js samo
# filtrira na prikazu (ne brise ih fizicki iz data.js).
$productCap = @{}
for ($i = 0; $i -lt $products.Count; $i++) { $productCap[$i] = Get-OutlierCap $products[$i][1] $products[$i][3] $products[$i][4] }
$lastMinByProd = @{}
$lastDateIdxByProd = @{}
foreach ($o in $obs) {
  $pi = $o[1]; $di = $o[0]; $mn = $o[3]
  $cap = $productCap[$pi]
  if ($mn -lt $OUTLIER_FLOOR -or $mn -gt $cap) { continue }
  if (-not $lastDateIdxByProd.ContainsKey($pi) -or $di -gt $lastDateIdxByProd[$pi]) {
    $lastDateIdxByProd[$pi] = $di
    $lastMinByProd[$pi] = $mn
  }
}
$priceChanges = [System.Collections.ArrayList]::new()
$CHANGE_THRESHOLD = 0.01  # EUR - manje od ovoga se ignorira kao zaokruzivanje

$lastDate = $dates[$dates.Count - 1]
Write-Host "Zadnji poznati datum: $lastDate"

Write-Host "== Dohvat popisa arhiva ==" -ForegroundColor Cyan
$listResp = Invoke-RestMethod -Uri 'https://api.cijene.dev/v0/list'
$archives = $listResp.archives | Sort-Object date

if ($Date) {
  $target = $archives | Where-Object { $_.date -eq $Date }
  if (-not $target) { throw "Arhiva za datum $Date nije pronadjena." }
} else {
  $missing = @($archives | Where-Object { $_.date -gt $lastDate })
  # Nedavni dani koje smo obradili iz nepotpune (jutarnje) verzije arhive, a
  # cijene.dev je u medjuvremenu objavio noviju - ponovno ih obradi.
  $recentCutoff = (Get-Date).AddDays(-4).ToString('yyyy-MM-dd')
  $stale = @($archives | Where-Object {
    $_.date -ge $recentCutoff -and $dates.Contains($_.date) -and $stamps.ContainsKey($_.date) -and
    [datetimeoffset]::Parse([string]$_.updated) -gt [datetimeoffset]::Parse($stamps[$_.date])
  })
  if ($stale.Count -gt 0 -or $missing.Count -gt 1) {
    # Racunalo je propustilo dan(e) (npr. spavalo u 06:30) - obradi SVE propustene
    # dane redom, ne samo najnoviji, inace ostaje rupa u povijesti cijena.
    if ($stale.Count -gt 0) { Write-Host "Osvjezavam: $(($stale | ForEach-Object { $_.date }) -join ', ')" -ForegroundColor Cyan }
    if ($missing.Count -gt 0) { Write-Host "Novi dani: $(($missing | ForEach-Object { $_.date }) -join ', ')" -ForegroundColor Cyan }
    foreach ($a in $stale) {
      & powershell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Date $a.date -Replace
    }
    foreach ($a in $missing) {
      & powershell -NoProfile -ExecutionPolicy Bypass -File $PSCommandPath -Date $a.date
    }
    return
  }
  $target = $missing | Select-Object -Last 1
  if (-not $target) {
    Write-Host "Nema novijih arhiva od $lastDate. Nista za napraviti." -ForegroundColor Yellow
    # Zadatak se okida i pri svakom otkljucavanju racunala, pa ovaj "nista novo"
    # mail salji najvise jednom dnevno.
    $noopMarker = Join-Path $root 'pipeline\.last-noop-mail'
    $todayIso = (Get-Date).ToString('yyyy-MM-dd')
    $alreadySent = (Test-Path $noopMarker) -and ((Get-Content $noopMarker -Raw).Trim() -eq $todayIso)
    if (-not $alreadySent) {
      $todayStr = (Get-Date).ToString('dd.MM.yyyy.')
      $html = (BigDateHeader $todayStr) + "<p style='font-family:Arial,sans-serif;font-size:16px;'><b>NE</b> - jos nije objavljena nova cijene.dev arhiva (zadnji obradjeni datum: $lastDate).</p>"
      Send-StatusEmail -Subject "Cijene vode $todayStr - nema nove arhive" -Html $html
      Set-Content -Path $noopMarker -Value $todayIso -Encoding ASCII
    }
    return
  }
}
$targetDate = $target.date
if ($replaceIdx -lt 0 -and $dates.Contains($targetDate)) {
  Write-Host "Datum $targetDate je vec u data.js. Preskace se." -ForegroundColor Yellow
  $dateStrBig = ([datetime]$targetDate).ToString('dd.MM.yyyy.')
  $html = (BigDateHeader $dateStrBig) + "<p style='font-family:Arial,sans-serif;font-size:16px;'>Arhiva za $targetDate je vec ranije obradjena.</p>"
  Send-StatusEmail -Subject "Cijene vode $dateStrBig - vec obradjeno" -Html $html
  return
}
Write-Host "Obradjujem arhivu za datum: $targetDate ($([math]::Round($target.size/1MB,1)) MB)" -ForegroundColor Cyan

New-Item -ItemType Directory -Force -Path $tempDir | Out-Null
$zipPath = Join-Path $tempDir "$targetDate.zip"
Write-Host "Preuzimanje..."
$dlSw = [System.Diagnostics.Stopwatch]::StartNew()
$wc = New-Object System.Net.WebClient
$wc.DownloadFile($target.url, $zipPath)
$wc.Dispose()
Write-Host ("Preuzeto za {0:N1}s" -f $dlSw.Elapsed.TotalSeconds)

Add-Type -AssemblyName System.IO.Compression.FileSystem
$zip = [System.IO.Compression.ZipFile]::OpenRead($zipPath)

if ($replaceIdx -ge 0) {
  $dateIdx = $replaceIdx
} else {
  $dateIdx = $dates.Count
  [void]$dates.Add($targetDate)
}

$chainFolders = $zip.Entries | Where-Object { $_.FullName -match '^([^/]+)/products\.csv$' } | ForEach-Object { $Matches[1] } | Sort-Object -Unique

$newProductCount = 0
$newObsCount = 0

foreach ($chain in $chainFolders) {
  $prodEntry = $zip.GetEntry("$chain/products.csv")
  $priceEntry = $zip.GetEntry("$chain/prices.csv")
  if (-not $prodEntry -or -not $priceEntry) { continue }

  # ---- products.csv: mali fajl (~20-25k redaka) - kvocirana polja (npr. kolicina
  # "0,2500" s decimalnim zarezom unutar navodnika) zahtijevaju pravi CSV parser,
  # zato ConvertFrom-Csv umjesto rucnog Split(',').
  $waterProducts = @{}   # product_id -> @{name; brand; unit; qty}
  $sr = New-Object System.IO.StreamReader($prodEntry.Open())
  try {
    $csvText = $sr.ReadToEnd()
  } finally { $sr.Close() }
  foreach ($row in ($csvText | ConvertFrom-Csv)) {
    if (-not (Is-WaterProduct $row.name)) { continue }
    $waterProducts[$row.product_id] = @{ name = $row.name; brand = $row.brand; unit = $row.unit; qty = $row.quantity; cap = (Get-OutlierCap $row.name $row.quantity $row.unit) }
  }

  if ($waterProducts.Count -eq 0) { continue }
  if (-not $chains.Contains($chain)) { [void]$chains.Add($chain) }

  # ---- prices.csv: veliki fajl (milijuni redaka) - streamati rucno, filtrirati
  # po product_id (HashSet lookup) bez kreiranja objekta za svaki redak koji ne prolazi.
  # kolone: store_id,product_id,price,unit_price,best_price_30,anchor_price,special_price
  $agg = @{}   # product_id -> list of @{price; special; anchor}
  $sr = New-Object System.IO.StreamReader($priceEntry.Open())
  try {
    $header = $sr.ReadLine()
    while (-not $sr.EndOfStream) {
      $line = $sr.ReadLine()
      if (-not $line) { continue }
      $comma1 = $line.IndexOf(',')
      if ($comma1 -lt 0) { continue }
      $comma2 = $line.IndexOf(',', $comma1 + 1)
      if ($comma2 -lt 0) { continue }
      $prodId = $line.Substring($comma1 + 1, $comma2 - $comma1 - 1)
      if (-not $waterProducts.ContainsKey($prodId)) { continue }
      $rest = $line.Substring($comma2 + 1) -split ','
      if ($rest.Count -lt 5) { continue }
      $priceStr = $rest[0]
      $anchorStr = $rest[3]
      $specialStr = $rest[4]
      $price = 0.0
      if (-not [double]::TryParse($priceStr, [System.Globalization.NumberStyles]::Any, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$price)) { continue }
      if ($price -lt $OUTLIER_FLOOR -or $price -gt $waterProducts[$prodId].cap) { continue }
      if (-not $agg.ContainsKey($prodId)) { $agg[$prodId] = [System.Collections.Generic.List[object]]::new() }
      $anchor = $null
      if ($anchorStr) {
        $a = 0.0
        if ([double]::TryParse($anchorStr, [System.Globalization.NumberStyles]::Any, [System.Globalization.CultureInfo]::InvariantCulture, [ref]$a)) { $anchor = $a }
      }
      $onPromo = [bool]$specialStr
      $agg[$prodId].Add(@{ price = $price; onPromo = $onPromo; anchor = $anchor })
    }
  } finally { $sr.Close() }

  foreach ($prodId in $agg.Keys) {
    $rows = $agg[$prodId]
    if ($rows.Count -eq 0) { continue }
    $prices = $rows | ForEach-Object { $_.price }
    $avg = [math]::Round((($prices | Measure-Object -Sum).Sum / $rows.Count), 4)
    $min = [math]::Round((($prices | Measure-Object -Minimum).Minimum), 4)
    $max = [math]::Round((($prices | Measure-Object -Maximum).Maximum), 4)
    $cnt = $rows.Count

    # tiers: [[price,storeCount],...] rastuce po cijeni, samo ako ima >1 razlicita cijena
    $byPrice = $rows | Group-Object { [math]::Round($_.price,2) } | Sort-Object { [double]$_.Name }
    $tiers = $null
    if ($byPrice.Count -gt 1) {
      $tiers = @($byPrice | ForEach-Object { , @([double]$_.Name, $_.Count) })
    }

    # promo: broj poslovnica na akciji + reprezentativna redovna (anchor) cijena -
    # anchor povezan s najcesce placenom (shelf) akcijskom cijenom
    $promoRows = $rows | Where-Object { $_.onPromo -and $_.anchor -ne $null }
    $promoCount = ($rows | Where-Object { $_.onPromo }).Count
    $anchorPrice = $null
    if ($promoCount -gt 0 -and $promoRows.Count -gt 0) {
      $bestGroup = $promoRows | Group-Object { [math]::Round($_.price,2) } | Sort-Object Count -Descending | Select-Object -First 1
      $anchorPrice = [math]::Round((($bestGroup.Group | ForEach-Object { $_.anchor } | Measure-Object -Average).Average), 4)
    }

    $info = $waterProducts[$prodId]
    $key = $chain + '|' + $info.name + '|' + $info.qty
    $isNewProduct = -not $productIndex.ContainsKey($key)
    if (-not $isNewProduct) {
      $prodIdx = $productIndex[$key]
    } else {
      $newRow = @($chain, $info.name, $info.brand, $info.qty, $info.unit, 'nepoznato')
      $prodIdx = $products.Count
      [void]$products.Add($newRow)
      $productIndex[$key] = $prodIdx
      $newProductCount++
    }

    if (-not $isNewProduct -and $lastMinByProd.ContainsKey($prodIdx)) {
      $oldMin = $lastMinByProd[$prodIdx]
      $effWtype = Get-EffectiveWtype $products[$prodIdx][5] $info.name
      # zlatno pravilo: usporeduje se najniza cijena dana, ne prosjek - jedan krivi
      # unos u jednoj poslovnici ne moze pomaknuti minimum osim ako je STVARNO
      # najjeftiniji taj dan, pa je ovo puno otpornije na pojedinacne greske u izvoru
      if (($effWtype -eq 'gazirana' -or $effWtype -eq 'negazirana') -and [math]::Abs($min - $oldMin) -ge $CHANGE_THRESHOLD) {
        [void]$priceChanges.Add([pscustomobject]@{
          chain = $chain; brand = $info.brand; name = $info.name
          oldPrice = $oldMin; newPrice = $min
          pct = [math]::Round((($min - $oldMin) / $oldMin) * 100, 1)
        })
      }
    }

    $obsRow = [System.Collections.ArrayList]::new()
    [void]$obsRow.Add($dateIdx)
    [void]$obsRow.Add($prodIdx)
    [void]$obsRow.Add($avg)
    [void]$obsRow.Add($min)
    [void]$obsRow.Add($max)
    [void]$obsRow.Add($cnt)
    if ($promoCount -gt 0) {
      [void]$obsRow.Add($tiers)   # moze biti $null - drzi poziciju fiksnu
      [void]$obsRow.Add($promoCount)
      [void]$obsRow.Add($anchorPrice)
    } elseif ($tiers) {
      [void]$obsRow.Add($tiers)
    }
    [void]$obs.Add(@($obsRow.ToArray()))
    $newObsCount++
  }
  Write-Host ("  {0}: {1} artikala vode, {2} agregiranih zapisa" -f $chain, $waterProducts.Count, $agg.Count)
}

$zip.Dispose()

Write-Host "== Serijalizacija natrag u data.js ==" -ForegroundColor Cyan
$out = [ordered]@{
  dates = $dates
  chains = $chains
  products = $products
  obs = $obs
}
$compact = $out | ConvertTo-Json -Depth 10 -Compress
# Pisi u privremeni fajl pa zamijeni - prekid usred pisanja (gasenje laptopa,
# timeout) inace ostavi prepolovljen data.js i app se vise ne ucita.
$tmpDataPath = "$dataPath.tmp"
[System.IO.File]::WriteAllText($tmpDataPath, "window.WATER_DATA=$compact;")
Move-Item -LiteralPath $tmpDataPath -Destination $dataPath -Force

$stamps[$targetDate] = [string]$target.updated
$stamps | ConvertTo-Json | Set-Content -Path $stampPath -Encoding UTF8

Remove-Item -Recurse -Force $tempDir -ErrorAction SilentlyContinue

# ---- log promjena cijena (osnova za buduci mail - za sad samo fajl na disku) ----
$changesDir = Join-Path $root 'pipeline\changes'
New-Item -ItemType Directory -Force -Path $changesDir | Out-Null
$changesPath = Join-Path $changesDir "$targetDate.csv"
if ($priceChanges.Count -gt 0) {
  $priceChanges | Sort-Object { [math]::Abs($_.pct) } -Descending |
    Select-Object chain, brand, name, oldPrice, newPrice, pct |
    Export-Csv -Path $changesPath -NoTypeInformation -Encoding UTF8
}
$latestChangesPath = Join-Path $root 'pipeline\changes\latest.txt'
if ($priceChanges.Count -gt 0) {
  $lines = $priceChanges | Sort-Object { [math]::Abs($_.pct) } -Descending | ForEach-Object {
    $dir = if ($_.newPrice -gt $_.oldPrice) { 'poskupjelo' } else { 'pojeftinilo' }
    "{0} - {1} ({2}): {3:N2} EUR -> {4:N2} EUR ({5}{6}%) [{7}]" -f $_.chain, $_.brand, $_.name, $_.oldPrice, $_.newPrice, $(if($_.pct -gt 0){'+'}else{''}), $_.pct, $dir
  }
  "Promjene cijena za $targetDate ($($priceChanges.Count) artikala):`n" + ($lines -join "`n") | Set-Content -Path $latestChangesPath -Encoding UTF8
} else {
  "Nema promjena cijena za $targetDate." | Set-Content -Path $latestChangesPath -Encoding UTF8
}

Write-Host "Gotovo. Dodan datum $targetDate - $newProductCount novih artikala, $newObsCount novih zapisa cijena, $($priceChanges.Count) promjena cijena." -ForegroundColor Green
Write-Host "Log promjena: $latestChangesPath"

# ---- dnevni status mail: DA/NE je li doslo do promjene, s velikim datumom ----
$dateStrBig = ([datetime]$targetDate).ToString('dd.MM.yyyy.')
$refreshNote = if ($replaceIdx -ge 0) { ' (konacna arhiva)' } else { '' }
if ($priceChanges.Count -gt 0) {
  $rows = $priceChanges | Sort-Object { [math]::Abs($_.pct) } -Descending | ForEach-Object {
    $dir = if ($_.newPrice -gt $_.oldPrice) { 'poskupjelo' } else { 'pojeftinilo' }
    $sign = if ($_.pct -gt 0) { '+' } else { '' }
    "<tr><td>$($_.chain)</td><td>$($_.brand)</td><td>$($_.name)</td><td style='text-align:right'>$('{0:N2}' -f $_.oldPrice)</td><td style='text-align:right'>$('{0:N2}' -f $_.newPrice)</td><td style='text-align:right'>$sign$($_.pct)%</td><td>$dir</td></tr>"
  }
  $table = "<table cellpadding='6' cellspacing='0' style='border-collapse:collapse;font-family:Arial,sans-serif;font-size:13px;'>" +
    "<tr style='background:#f0f0f0'><th>Lanac</th><th>Marka</th><th>Artikl</th><th>Stara</th><th>Nova</th><th>%</th><th></th></tr>" +
    ($rows -join '') + "</table>"
  $html = (BigDateHeader $dateStrBig) + "<p style='font-family:Arial,sans-serif;font-size:17px;'><b>DA</b> - doslo je do promjene cijena ($($priceChanges.Count) artikala).</p>" + $table
  $subject = "Cijena vode $dateStrBig$refreshNote - DA, promjena ($($priceChanges.Count))"
} else {
  $html = (BigDateHeader $dateStrBig) + "<p style='font-family:Arial,sans-serif;font-size:17px;'><b>NE</b> - nije doslo do promjene cijena danas.</p>"
  $subject = "Cijena vode $dateStrBig$refreshNote - NE, nema promjene"
}
Send-StatusEmail -Subject $subject -Html $html
