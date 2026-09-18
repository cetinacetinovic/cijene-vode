<#
.SYNOPSIS
  Minimalni staticki HTTP server (bez Node/Python) za lokalni pregled app/ foldera.
#>
param([int]$Port = 8734)

$root = Join-Path (Split-Path -Parent $PSScriptRoot) 'app'
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Start()
Write-Host "Serving $root on http://localhost:$Port/ (Ctrl+C to stop)"

$mime = @{ '.html'='text/html'; '.js'='text/javascript'; '.css'='text/css'; '.json'='application/json' }

while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  $reqPath = $ctx.Request.Url.LocalPath
  if ($reqPath -eq '/') { $reqPath = '/index.html' }
  $filePath = Join-Path $root ($reqPath.TrimStart('/'))
  # Bez ovoga preglednik zna posluziti STARU verziju index.html/app.js iz
  # svoje keš-memorije cak i na obican refresh (nema Last-Modified/ETag pa
  # nasljedjuje heuristicko keširanje) - zbunjujuce kad se datoteka upravo
  # promijenila a stranica izgleda kao da izmjena nije stigla.
  $ctx.Response.Headers.Add('Cache-Control', 'no-store, no-cache, must-revalidate')
  $ctx.Response.Headers.Add('Pragma', 'no-cache')
  $ctx.Response.Headers.Add('Expires', '0')
  if (Test-Path $filePath -PathType Leaf) {
    $ext = [System.IO.Path]::GetExtension($filePath)
    $contentType = $mime[$ext]
    if (-not $contentType) { $contentType = 'application/octet-stream' }
    $ctx.Response.ContentType = $contentType
    $bytes = [System.IO.File]::ReadAllBytes($filePath)
    $ctx.Response.ContentLength64 = $bytes.Length
    $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
  } else {
    $ctx.Response.StatusCode = 404
  }
  $ctx.Response.OutputStream.Close()
}
