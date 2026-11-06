# HOGARSTOCK V3 | DEMOSTRACION LOCAL REUTILIZABLE
# Solo datos ficticios. No modifica V2, Render, Turso ni WhatsApp.
# Pegar este archivo COMPLETO en PowerShell de Windows. Pregunta S/N.
# Primera ejecucion: prepara D:\HOGARSTOCK_V3_PRUEBA_LOCAL.
# Siguientes ejecuciones: utiliza la misma copia sin borrarla ni actualizarla.

$ErrorActionPreference = 'Stop'
$Directorio = 'D:\HOGARSTOCK_V3_PRUEBA_LOCAL'
$Rama = 'seguridad-pruebas-2026-11-05'
$Repositorio = 'https://github.com/hectornemecio-eng/hogarstock.git'
$fuente = Join-Path $Directorio 'FUENTE_V3'
$librerias = Join-Path $Directorio 'DEPENDENCIAS_AISLADAS'
$temp = Join-Path $Directorio 'TEMP'
$original = @{}
$nombres = @('HOGARSTOCK_V3_SANDBOX','HOGARSTOCK_SANDBOX_CERT',
    'HOGARSTOCK_SANDBOX_KEY','NODE_PATH','NODE_OPTIONS',
    'NODE_TLS_REJECT_UNAUTHORIZED','npm_config_cache','TMP','TEMP')
$variablesPreparadas = $false
$cert = $null
$key = $null

function Buscar-Comando([string]$Nombre) {
    $comando = Get-Command $Nombre -ErrorAction SilentlyContinue |
        Select-Object -First 1
    if ($null -eq $comando) { throw "REQUISITO_AUSENTE: $Nombre" }
    return $comando.Source
}
function Exigir-CodigoCorrecto([string]$Codigo) {
    if ($LASTEXITCODE -ne 0) { throw $Codigo }
}

try {
    if (-not (Test-Path -LiteralPath 'D:\')) {
        throw 'NO_EXISTE_LA_UNIDAD_D'
    }
    if ($env:TURSO_DATABASE_URL -or $env:TURSO_AUTH_TOKEN -or
        $env:WA_MASTER_KEY -or $env:HOGARSTOCK_V3_WHATSAPP_LIVE -eq '1') {
        throw 'VARIABLES_DE_PRODUCCION_PRESENTES'
    }
    $git = Buscar-Comando 'git.exe'
    $node = Buscar-Comando 'node.exe'
    $npm = Buscar-Comando 'npm.cmd'
    $nodeVersion = (& $node --version).Trim()
    Exigir-CodigoCorrecto 'NODE_NO_DISPONIBLE'
    $major = [int](($nodeVersion.TrimStart('v')).Split('.')[0])
    if ($major -lt 22) { throw 'SE_REQUIERE_NODE_22_O_SUPERIOR' }

    $openssl = Get-Command 'openssl.exe' -ErrorAction SilentlyContinue |
        Select-Object -First 1 -ExpandProperty Source
    if (-not $openssl) {
        $candidatos = @(
            (Join-Path $env:ProgramFiles 'Git\usr\bin\openssl.exe'),
            (Join-Path $env:ProgramFiles 'Git\mingw64\bin\openssl.exe')
        )
        $openssl = $candidatos | Where-Object {
            Test-Path -LiteralPath $_
        } | Select-Object -First 1
    }
    if (-not $openssl) { throw 'NO_SE_ENCUENTRA_OPENSSL_EN_GIT_O_PATH' }

    $primerUso = -not (Test-Path -LiteralPath $Directorio)
    if (-not $primerUso) {
        if (-not (Test-Path -LiteralPath (Join-Path $fuente '.git')) -or
            -not (Test-Path -LiteralPath (Join-Path $fuente 'integration\launch-v3-local.js'))) {
            throw 'CARPETA_EXISTENTE_INCOMPLETA: no se sobrescribe; revisar manualmente'
        }
        $ramaLocal = (& $git -C $fuente branch --show-current).Trim()
        Exigir-CodigoCorrecto 'NO_SE_PUDO_VERIFICAR_RAMA_LOCAL'
        $origen = (& $git -C $fuente remote get-url origin).Trim()
        Exigir-CodigoCorrecto 'NO_SE_PUDO_VERIFICAR_REPOSITORIO'
        if ($ramaLocal -ne $Rama -or $origen -ne $Repositorio) {
            throw 'COPIA_LOCAL_NO_CORRESPONDE_A_HOGARSTOCK_V3'
        }
        $cambios = (& $git -C $fuente status --porcelain)
        Exigir-CodigoCorrecto 'NO_SE_PUDO_VERIFICAR_ESTADO_GIT'
        if ($cambios) {
            throw 'COPIA_LOCAL_MODIFICADA: no se ejecuta codigo sin verificar'
        }
    }

    Write-Host ''
    Write-Host 'HOGARSTOCK V3 - PRUEBA LOCAL' -ForegroundColor Cyan
    Write-Host 'Ubicacion: ' $Directorio
    Write-Host 'Primera instalacion: ' $primerUso
    Write-Host 'Datos: ficticios, temporales y solo en este equipo.'
    Write-Host 'Sin WhatsApp, sin Turso remoto y sin modificaciones en Render.'
    Write-Host 'No se instalan certificados en Windows ni herramientas globales.'
    if (-not $primerUso) {
        Write-Host 'Se utilizara la version local existente, SIN actualizacion automatica.'
    }
    $respuesta = (Read-Host 'Autorizar la preparacion/inicio de la demo (S/N)').Trim().ToUpperInvariant()
    if ($respuesta -ne 'S') {
        Write-Host 'CANCELADO: no se ha cambiado nada.'
        return
    }

    if ($primerUso) {
        New-Item -ItemType Directory -Path $Directorio -ErrorAction Stop | Out-Null
    }
    if (-not (Test-Path -LiteralPath $temp)) {
        New-Item -ItemType Directory -Path $temp -ErrorAction Stop | Out-Null
    }
    foreach ($nombre in $nombres) {
        $original[$nombre] = [Environment]::GetEnvironmentVariable($nombre,'Process')
    }
    $variablesPreparadas = $true
    $env:TEMP = $temp
    $env:TMP = $temp
    $env:npm_config_cache = Join-Path $Directorio 'CACHE_NPM'
    $env:NODE_TLS_REJECT_UNAUTHORIZED = '1'
    $env:NODE_OPTIONS = ''

    if ($primerUso) {
        & $git clone --depth 1 --single-branch --branch $Rama $Repositorio $fuente
        Exigir-CodigoCorrecto 'CLONACION_FALLIDA'
    }
    $commit = (& $git -C $fuente rev-parse HEAD).Trim()
    Exigir-CodigoCorrecto 'COMMIT_NO_VERIFICADO'
    Write-Host ('Commit del ensayo: ' + $commit)

    $pkgExpress = Join-Path $librerias 'node_modules\express\package.json'
    $pkgLibsql = Join-Path $librerias 'node_modules\@libsql\client\package.json'
    if (-not (Test-Path -LiteralPath $pkgExpress) -or
        -not (Test-Path -LiteralPath $pkgLibsql)) {
        $argsNpm = @('install','--prefix',$librerias,'--no-save',
            '--package-lock=false','--ignore-scripts','--no-audit','--no-fund',
            '@libsql/client@0.14.0','express@4.21.2')
        & $npm @argsNpm
        Exigir-CodigoCorrecto 'DEPENDENCIAS_DE_LA_DEMO_NO_INSTALADAS'
    }

    $identificador = [guid]::NewGuid().ToString('N')
    $cert = Join-Path $temp ("localhost-" + $identificador + ".crt")
    $key = Join-Path $temp ("localhost-" + $identificador + ".key")
    $argsOpenSsl = @('req','-x509','-newkey','rsa:2048','-sha256',
        '-nodes','-days','1','-keyout',$key,'-out',$cert,
        '-subj','/CN=127.0.0.1','-addext','subjectAltName=IP:127.0.0.1')
    & $openssl @argsOpenSsl
    Exigir-CodigoCorrecto 'NO_SE_PUDO_GENERAR_CERTIFICADO_LOCAL'

    $env:HOGARSTOCK_V3_SANDBOX = '1'
    $env:HOGARSTOCK_SANDBOX_CERT = $cert
    $env:HOGARSTOCK_SANDBOX_KEY = $key
    $env:NODE_PATH = Join-Path $librerias 'node_modules'

    Write-Host ''
    Write-Host 'INICIANDO V3 - SOLO EN ESTE ORDENADOR' -ForegroundColor Cyan
    Write-Host 'El servidor mostrara una URL https://127.0.0.1 y la clave DEMO.'
    Write-Host 'El certificado autofirmado puede producir una advertencia local.'
    Write-Host 'Para terminar: Ctrl+C. Puedes ejecutar este script nuevamente.'
    & $node (Join-Path $fuente 'integration\launch-v3-local.js')
    Exigir-CodigoCorrecto 'DEMOSTRACION_CERRADA_CON_ERROR'
}
catch {
    Write-Host ('ERROR: ' + $_.Exception.Message) -ForegroundColor Red
    Write-Host 'Produccion y sus datos no se han modificado desde esta prueba.'
    Write-Host 'No se borra ninguna carpeta de ensayo existente.'
}
finally {
    if ($variablesPreparadas) {
        foreach ($nombre in $nombres) {
            [Environment]::SetEnvironmentVariable($nombre,$original[$nombre],'Process')
        }
    }
    # Eliminar SOLO los dos archivos efimeros generados en esta ejecucion.
    foreach ($archivo in @($cert,$key)) {
        if ($archivo -and (Test-Path -LiteralPath $archivo)) {
            Remove-Item -LiteralPath $archivo -Force -ErrorAction SilentlyContinue
        }
    }
}
