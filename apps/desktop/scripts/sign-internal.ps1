param(
  [string]$Password = 'OpsAgent-Internal',
  [string]$Subject = 'CN=OpsAgent Internal Code Signing',
  [switch]$TrustCertificate
)

$ErrorActionPreference = 'Stop'
$app = Split-Path -Parent $PSScriptRoot
$cert = New-SelfSignedCertificate `
  -Type CodeSigningCert `
  -Subject $Subject `
  -CertStoreLocation Cert:\CurrentUser\My `
  -KeyExportPolicy Exportable `
  -KeyUsage DigitalSignature `
  -NotAfter (Get-Date).AddYears(3)

$pfx = Join-Path $env:TEMP 'opsagent-internal-sign.pfx'
$secure = ConvertTo-SecureString -String $Password -Force -AsPlainText
Export-PfxCertificate -Cert $cert -FilePath $pfx -Password $secure | Out-Null

if ($TrustCertificate) {
  $root = Join-Path $env:TEMP 'opsagent-internal-ca.cer'
  Export-Certificate -Cert $cert -FilePath $root | Out-Null
  Import-Certificate -FilePath $root -CertStoreLocation Cert:\CurrentUser\Root | Out-Null
  Import-Certificate -FilePath $root -CertStoreLocation Cert:\CurrentUser\TrustedPublisher | Out-Null
}

$env:CSC_LINK = $pfx
$env:CSC_KEY_PASSWORD = $Password
Push-Location $app
try {
  & pnpm package:win
} finally {
  Pop-Location
}

Write-Output "certificate=$($cert.Thumbprint)"
Write-Output "installer=$app\release\OpsAgent Setup 0.2.0.exe"
