# HogarStock V3 - auditoria V2 Turso de SOLO LECTURA
# En la rama experimental. No instalar ni modificar configuraciones globales.
# No guarda datos ni imprime contrasenas, tokens o URL de Turso.
# Debe iniciarse desde una consola que YA tenga:
# TURSO_DATABASE_URL, TURSO_AUTH_TOKEN y
# HOGARSTOCK_V2_PRODUCTION_HOST (hostname revisado de la BD V2).
# No se buscan ni abren automaticamente ficheros .env.
$ErrorActionPreference = 'Stop'

Write-Host '=== HOGARSTOCK | AUDITORIA METADATOS V2 ==='
Write-Host 'Modo: SOLO 3 consultas SELECT/PRAGMA, sin leer filas de productos.'
Write-Host 'No descarga copias ni guarda informacion privada.'
Write-Host 'No modifica Render, Turso, WhatsApp ni GitHub.'

$node = Get-Command node -ErrorAction SilentlyContinue
if (-not $node) {
    Write-Host 'BLOQUEADO: Node.js no aparece en PATH.' -ForegroundColor Red
    return
}
$archivo = Join-Path $PSScriptRoot 'v3-auditar-turso-v2-solo-lectura.js'
if (-not (Test-Path -LiteralPath $archivo -PathType Leaf)) {
    Write-Host 'BLOQUEADO: falta el archivo Node de auditoria.' -ForegroundColor Red
    return
}
$requeridas = @(
    'TURSO_DATABASE_URL',
    'TURSO_AUTH_TOKEN',
    'HOGARSTOCK_V2_PRODUCTION_HOST'
)
$faltantes = @($requeridas | Where-Object {
    [string]::IsNullOrWhiteSpace([Environment]::GetEnvironmentVariable($_, 'Process'))
})
if ($faltantes.Count -gt 0) {
    Write-Host ('BLOQUEADO: faltan variables en esta sesion: ' + ($faltantes -join ', ')) -ForegroundColor Yellow
    Write-Host 'No introduzcas secretos en el chat ni los guardes en el repositorio.'
    return
}

$cuota = (Read-Host '¿Has verificado que estas consultas estan dentro del plan gratuito Turso y no pueden generar cargos? (S/N)').Trim().ToUpperInvariant()
if ($cuota -ne 'S') {
    Write-Host 'AUDITORIA_NO_EJECUTADA | CUOTA_NO_CONFIRMADA'
    return
}
$autorizar = (Read-Host '¿Autorizas EXCLUSIVAMENTE la auditoria de metadatos V2, sin escrituras? (S/N)').Trim().ToUpperInvariant()
if ($autorizar -ne 'S') {
    Write-Host 'AUDITORIA_NO_EJECUTADA | AUTORIZACION_NO_CONFIRMADA'
    return
}

$readBefore = [Environment]::GetEnvironmentVariable('HOGARSTOCK_V2_AUDIT_READONLY','Process')
$quotaBefore = [Environment]::GetEnvironmentVariable('HOGARSTOCK_V2_AUDIT_CUOTA_VERIFICADA','Process')
try {
    $env:HOGARSTOCK_V2_AUDIT_READONLY = 'S'
    $env:HOGARSTOCK_V2_AUDIT_CUOTA_VERIFICADA = 'S'
    & $node.Source $archivo
    if ($LASTEXITCODE -ne 0) {
        Write-Host 'AUDITORIA_NO_CONFIRMADA | El programa ha terminado con error.' -ForegroundColor Yellow
    } else {
        Write-Host 'AUDITORIA_CONSULTAS_COMPLETADA | Esto NO acredita respaldo ni migracion.'
    }
} finally {
    if ($null -eq $readBefore) { Remove-Item 'Env:HOGARSTOCK_V2_AUDIT_READONLY' -ErrorAction SilentlyContinue }
    else { $env:HOGARSTOCK_V2_AUDIT_READONLY = $readBefore }
    if ($null -eq $quotaBefore) { Remove-Item 'Env:HOGARSTOCK_V2_AUDIT_CUOTA_VERIFICADA' -ErrorAction SilentlyContinue }
    else { $env:HOGARSTOCK_V2_AUDIT_CUOTA_VERIFICADA = $quotaBefore }
}
