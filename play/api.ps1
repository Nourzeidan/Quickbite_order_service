# Load once per PowerShell window:   . .\play\api.ps1
# api <METHOD> <url> [-Body @{...}] [-Token $t] [-Region eg] [-Key <idempotency-key>] [-ApiKey <core internal key>]
# Prints "<status> <body>" (also for 4xx/5xx) and returns the parsed JSON.
function api {
    param(
        [Parameter(Mandatory)][string]$Method,
        [Parameter(Mandatory)][string]$Url,
        $Body,
        [string]$Token,
        [string]$Region,
        [string]$Key,
        [string]$ApiKey
    )
    $headers = @{}
    if($Token){ $headers["Authorization"] = "Bearer $Token" }
    if($Region){ $headers["X-Region"] = $Region }
    if($Key){ $headers["Idempotency-Key"] = $Key }
    if($ApiKey){ $headers["api-key"] = $ApiKey }

    $params = @{Method = $Method; Uri = $Url; Headers = $headers; UseBasicParsing = $true; ContentType = "application/json"}
    if($null -ne $Body){
        $params["Body"] = if($Body -is [string]){ $Body } else { $Body | ConvertTo-Json -Depth 10 -Compress }
    }

    try{
        $res = Invoke-WebRequest @params
        $status = [int]$res.StatusCode
        $text = $res.Content
    }catch{
        $resp = $_.Exception.Response
        if(-not $resp){ Write-Host "request failed: $($_.Exception.Message)" -ForegroundColor Red; return }
        $status = [int]$resp.StatusCode
        # PowerShell 5.1 puts the error body in ErrorDetails (the response stream is already read)
        $text = if($_.ErrorDetails -and $_.ErrorDetails.Message){ $_.ErrorDetails.Message } else { "" }
    }

    $color = if($status -lt 300){ "Green" } elseif($status -lt 500){ "Yellow" } else { "Red" }
    Write-Host "$status $text" -ForegroundColor $color
    if($text){ try{ return $text | ConvertFrom-Json }catch{ return $text } }
}
