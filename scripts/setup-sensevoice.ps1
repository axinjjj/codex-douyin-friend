[CmdletBinding()]
param()

$ErrorActionPreference = "Stop"
$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new()

$ProjectRoot = Split-Path -Parent $PSScriptRoot
$ToolRoot = Join-Path $ProjectRoot ".runtime\tools\sensevoice"
$DownloadRoot = Join-Path $ToolRoot "downloads"
$RuntimeRoot = Join-Path $ToolRoot "runtime"
$TestRoot = Join-Path $ToolRoot "tests"
$RuntimeArchive = Join-Path $DownloadRoot "funasr-llamacpp-windows-x64.zip"
$SenseVoiceModel = Join-Path $DownloadRoot "sensevoice-small-q8.gguf"
$VadModel = Join-Path $DownloadRoot "fsmn-vad.gguf"
$RuntimeExecutable = Join-Path $RuntimeRoot "llama-funasr-sensevoice.exe"
$TestAudio = Join-Path $TestRoot "sample.wav"
$ExpectedRuntimeExecutableSha256 = "eb1faf1f7251c6756e4c28fa1fe3f47d3691449bde6f38bc322a3eb5df43466c"
$NormalizedToolRoot = [IO.Path]::GetFullPath($ToolRoot).TrimEnd([IO.Path]::DirectorySeparatorChar)
$CurlExecutable = (Get-Command curl.exe -ErrorAction Stop).Source

function Assert-ToolPath {
    param([Parameter(Mandatory)][string]$CandidatePath)
    $NormalizedCandidate = [IO.Path]::GetFullPath($CandidatePath)
    $ExpectedPrefix = $NormalizedToolRoot + [IO.Path]::DirectorySeparatorChar
    if (-not $NormalizedCandidate.StartsWith($ExpectedPrefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw "Refusing to write outside the dedicated SenseVoice runtime directory."
    }
}

function Get-VerifiedDownload {
    param(
        [Parameter(Mandatory)][string]$SourceUrl,
        [Parameter(Mandatory)][string]$DestinationPath,
        [Parameter(Mandatory)][string]$ExpectedSha256
    )
    Assert-ToolPath -CandidatePath $DestinationPath
    if (Test-Path -LiteralPath $DestinationPath) {
        $ExistingHash = (Get-FileHash -LiteralPath $DestinationPath -Algorithm SHA256).Hash.ToLowerInvariant()
        if ($ExistingHash -eq $ExpectedSha256) {
            Write-Host "Verified existing $([IO.Path]::GetFileName($DestinationPath))"
            return
        }
    }

    $PartialPath = "$DestinationPath.part"
    Assert-ToolPath -CandidatePath $PartialPath
    if (Test-Path -LiteralPath $PartialPath) {
        Remove-Item -LiteralPath $PartialPath -Force
    }
    & $CurlExecutable --fail --location --silent --show-error --retry 3 --output $PartialPath $SourceUrl
    if ($LASTEXITCODE -ne 0) {
        throw "Download failed for $([IO.Path]::GetFileName($DestinationPath))."
    }
    $DownloadedHash = (Get-FileHash -LiteralPath $PartialPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($DownloadedHash -ne $ExpectedSha256) {
        Remove-Item -LiteralPath $PartialPath -Force
        throw "SHA-256 verification failed for $([IO.Path]::GetFileName($DestinationPath))."
    }
    Move-Item -LiteralPath $PartialPath -Destination $DestinationPath -Force
    Write-Host "Downloaded and verified $([IO.Path]::GetFileName($DestinationPath))"
}

New-Item -ItemType Directory -Path $DownloadRoot -Force | Out-Null
New-Item -ItemType Directory -Path $RuntimeRoot -Force | Out-Null
New-Item -ItemType Directory -Path $TestRoot -Force | Out-Null

Get-VerifiedDownload `
    -SourceUrl "https://github.com/QwenAudio/SenseVoice/releases/download/runtime-llamacpp-v0.2.1/funasr-llamacpp-windows-x64.zip" `
    -DestinationPath $RuntimeArchive `
    -ExpectedSha256 "b8f2b8f241b57921d82d64068d9b5695629779f3db5f3205a730cb3810232bb4"
Get-VerifiedDownload `
    -SourceUrl "https://huggingface.co/FunAudioLLM/SenseVoiceSmall-GGUF/resolve/90c1c61912018b70ada0fcc024ea24aca62f2e63/sensevoice-small-q8.gguf?download=true" `
    -DestinationPath $SenseVoiceModel `
    -ExpectedSha256 "4ae45c94422de949b387e2e0fb10d7e14e4c42c69db30c3444ecc7d4b844b7c5"
Get-VerifiedDownload `
    -SourceUrl "https://huggingface.co/FunAudioLLM/fsmn-vad-GGUF/resolve/6840bae4c5c92ee8c04faaf4db23dd0105098d7f/fsmn-vad.gguf?download=true" `
    -DestinationPath $VadModel `
    -ExpectedSha256 "1270f2559c495f4e7b6e739541151027d360761a3fda43fc147034f5719f5479"
Get-VerifiedDownload `
    -SourceUrl "https://raw.githubusercontent.com/QwenAudio/SenseVoice/4a131bd6ec0ece6cc1b00a063623223a970d4519/runtime/llama.cpp/tests/sample.wav" `
    -DestinationPath $TestAudio `
    -ExpectedSha256 "ea03e1f473ad1618a03da3327a545369cb8f6f06cb0f4115535e5a866167d47e"

$NeedsExtraction = $true
if (Test-Path -LiteralPath $RuntimeExecutable -PathType Leaf) {
    $RuntimeExecutableHash = (Get-FileHash -LiteralPath $RuntimeExecutable -Algorithm SHA256).Hash.ToLowerInvariant()
    $NeedsExtraction = $RuntimeExecutableHash -ne $ExpectedRuntimeExecutableSha256
}
if ($NeedsExtraction) {
    Expand-Archive -LiteralPath $RuntimeArchive -DestinationPath $RuntimeRoot -Force
}
if (-not (Test-Path -LiteralPath $RuntimeExecutable -PathType Leaf)) {
    throw "SenseVoice executable is missing after extraction."
}

$PreviousNativePreference = $ErrorActionPreference
$ErrorActionPreference = "Continue"
$HelpOutput = (& $RuntimeExecutable --help 2>&1 | Out-String)
$RuntimeExitCode = $LASTEXITCODE
$ErrorActionPreference = $PreviousNativePreference
if ($RuntimeExitCode -ne 1 -or $HelpOutput -notmatch "usage:" -or $HelpOutput -notmatch "--srt") {
    throw "SenseVoice executable did not pass its launch self-check."
}

Write-Host "SenseVoice local runtime is ready."
