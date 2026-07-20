# Minimal static file server for previewing positions.html over http:// instead
# of file:// (needed so the Browser pane executes the page's JS instead of
# just rendering a static snapshot). Uses .NET's HttpListener - no Node/Python
# required, since neither is installed in this environment.
$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$port = 8181

$mimeTypes = @{
  ".html" = "text/html; charset=utf-8"
  ".htm"  = "text/html; charset=utf-8"
  ".css"  = "text/css"
  ".js"   = "application/javascript"
  ".json" = "application/json"
  ".png"  = "image/png"
  ".jpg"  = "image/jpeg"
  ".jpeg" = "image/jpeg"
  ".svg"  = "image/svg+xml"
  ".ico"  = "image/x-icon"
}

$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://localhost:$port/")
$listener.Start()
Write-Host "Serving $root on http://localhost:$port/"

while ($listener.IsListening) {
  $context = $listener.GetContext()
  $request = $context.Request
  $response = $context.Response
  try {
    $localPath = $request.Url.LocalPath
    if ($localPath -eq "/") { $localPath = "/positions.html" }
    $filePath = Join-Path $root ($localPath.TrimStart("/"))
    $fullRoot = (Resolve-Path $root).Path
    if ((Test-Path $filePath -PathType Leaf) -and ((Resolve-Path $filePath).Path.StartsWith($fullRoot))) {
      $ext = [System.IO.Path]::GetExtension($filePath)
      $contentType = $mimeTypes[$ext]
      if (-not $contentType) { $contentType = "application/octet-stream" }
      $bytes = [System.IO.File]::ReadAllBytes($filePath)
      $response.ContentType = $contentType
      $response.ContentLength64 = $bytes.Length
      $response.OutputStream.Write($bytes, 0, $bytes.Length)
    } else {
      $response.StatusCode = 404
      $msg = [System.Text.Encoding]::UTF8.GetBytes("404 Not Found")
      $response.OutputStream.Write($msg, 0, $msg.Length)
    }
  } catch {
  } finally {
    $response.OutputStream.Close()
  }
}
