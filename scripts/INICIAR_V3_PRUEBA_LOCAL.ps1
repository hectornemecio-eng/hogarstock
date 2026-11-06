# HogarStock V3 - Vista local con datos ficticios.
# PEGAR EN POWERSHELL COMPLETO, o ejecutar como .ps1 si esta permitido.
# NO modifica E:\hogarstock, Render, Turso, WhatsApp ni GitHub main.
# Crea SOLO una carpeta nueva en D:, instala dependencias dentro y pide S/N.

$ErrorActionPreference = 'Stop'
$Directorio = 'D:\HOGARSTOCK_V3_PRUEBA_LOCAL'
$Rama = 'seguridad-pruebas-2026-11-05'
$Repositorio = 'https://github.com/hectornemecio-eng/hogarstock.git'

function Buscar-Comando([string]$Nombre) {
    $comando = Get-Command $Nombre -ErrorAction SilentlyContinue
    if ($null -eq $comando) { throw "REQUISITO_AUSENTE: $Nombre" }
    return $comando.Source
}

try {
    if (-not (Test-Path -LiteralPath 'D:\')) {
        throw 'UNIDAD_D_NO_ENCONTRADA. No se ha realizado ningun cambio.'
    }
    if (Test-Path -LiteralPath $Directorio) {
        throw 'DESTINO_YA_EXISTE. No se borra ni sobrescribe esa carpeta.'
    }
    if (-not [string]::IsNullOrEmpty($env:TURSO_DATABASE_URL) -or
        -not [string]::IsNullOrEmpty($env:TURSO_AUTH_TOKEN) -or
        $env:HOGARSTOCK_V3_WHATSAPP_LIVE -eq '1' -or
        -not [string]::IsNullOrEmpty($env:WA_MASTER_KEY)) {
        throw 'ENTORNO_DE_PRODUCCION_DETECTADO. No iniciar pruebas en esta consola.'
    }

    $git = Buscar-Comando 'git'
    $node = Buscar-Comando 'node'
    $npm = Buscar-Comando 'npm.cmd'

    $openssl = (Get-Command 'openssl.exe' -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty Source)
    if (-not $openssl) {
        $candidatos = @(
            (Join-Path $env:ProgramFiles 'Git\usr\bin\openssl.exe'),
            (Join-Path $env:ProgramFiles 'Git\mingw64\bin\openssl.exe')
        )
        $openssl = $candidatos | Where-Object { Test-Path -LiteralPath $_ } |
            Select-Object -First 1
    }
    if (-not $openssl) {
        throw 'OPENSSL_NO_DISPONIBLE. Necesario para un certificado temporal; no se ha instalado nada.'
    }

    Write-Host ''
    Write-Host 'HOGARSTOCK V3 | VISTA LOCAL Y FICTICIA' -ForegroundColor Cyan
    Write-Host 'Carpeta exclusiva:' $Directorio
    Write-Host 'Clonara unicamente la rama de pruebas.'
    Write-Host 'Instalara Express y libSQL SOLAMENTE dentro de la carpeta de ensayos.'
    Write-Host 'Certificado temporal NO confiable, sin instalar certificados en Windows.'
    Write-Host 'WhatsApp y Turso remoto NO se conectaran.'
    Write-Host 'El catalogo y las compras de la demostracion se eliminan al cerrar Node.'
    $respuesta = (Read-Host 'Crear e iniciar esta vista local? (S/N)').Trim().ToUpperInvariant()
    if ($respuesta -ne 'S') {
        Write-Host 'CANCELADO: sin cambios.'
        return
    }

    New-Item -ItemType Directory -Path $Directorio -ErrorAction Stop | Out-Null
    $fuente = Join-Path $Directorio 'FUENTE_V3'
    $librerias = Join-Path $Directorio 'DEPENDENCIAS_AISLADAS'
    $temp = Join-Path $Directorio 'TEMP'
    New-Item -ItemType Directory -Path $temp -Force | Out-Null

    & $git clone --depth 1 --single-branch --branch $Rama $Repositorio $fuente
    if ($LASTEXITCODE -ne 0) { throw 'DESCARGA_GITHUB_FALLIDA. No se ha tocado produccion.' }
    $commit = (& $git -C $fuente rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'NO_SE_PUDO_VERIFICAR_EL_COMMIT.' }
    Write-Host 'Version local:' $commit

    & $npm install --prefix $librerias --no-save --package-lock=false --ignore-scripts --no-audit --no-fund '@libsql/client@0.14.0' 'express@4.21.2'
    if ($LASTEXITCODE -ne 0) { throw 'DEPENDENCIAS_NO_INSTALADAS.' }

    $cert = Join-Path $temp 'localhost-demo.crt'
    $key = Join-Path $temp 'localhost-demo.key'
    & $openssl req -x509 -newkey rsa:2048 -sha256 -nodes -days 1 -keyout $key -out $cert -subj '/CN=127.0.0.1' -addext 'subjectAltName=IP:127.0.0.1'
    if ($LASTEXITCODE -ne 0) { throw 'CERTIFICADO_LOCAL_NO_GENERADO.' }

    $anterior = @{}
    $nombres = @('HOGARSTOCK_V3_SANDBOX','HOGARSTOCK_SANDBOX_CERT',
        'HOGARSTOCK_SANDBOX_KEY','NODE_PATH','TMP','TEMP')
    foreach ($nombre in $nombres) {
        $anterior[$nombre] = [Environment]::GetEnvironmentVariable($nombre,'Process')
    }
    try {
        $env:HOGARSTOCK_V3_SANDBOX = '1'
        $env:HOGARSTOCK_SANDBOX_CERT = $cert
        $env:HOGARSTOCK_SANDBOX_KEY = $key
        $env:NODE_PATH = Join-Path $librerias 'node_modules'
        $env:TMP = $temp
        $env:TEMP = $temp

        Write-Host ''
        Write-Host 'Abriendo vista de pruebas HTTPS en este equipo...' -ForegroundColor Cyan
        Write-Host 'El certificado local no es un certificado publico de produccion.'
        Write-Host 'Pulsa Ctrl+C cuando termines. No cierres la consola durante la prueba.'
        & $node (Join-Path $fuente 'integration\launch-v3-local.js')
        if ($LASTEXITCODE -ne 0) { throw 'VISTA_LOCAL_NO_INICIADA_O_CERRADA_CON_ERROR.' }
    } finally {
        foreach ($nombre in $nombres) {
            [Environment]::SetEnvironmentVariable($nombre,$anterior[$nombre],'Process')
        }
    }
} catch {
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'No se ha alterado la aplicacion publicada ni la base de datos real.'
    Write-Host 'La carpeta de ensayos, si llego a crearse, se conserva para inspeccion.'
}
