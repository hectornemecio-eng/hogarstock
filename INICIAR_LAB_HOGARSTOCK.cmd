@echo off
setlocal
cd /d "%~dp0"
title HogarStock v4.04 - LABORATORIO LOCAL
echo =============================================
echo HOGARSTOCK - LABORATORIO LOCAL SIN PRODUCCION
echo =============================================
where node.exe >nul 2>nul
if errorlevel 1 (
  echo ERROR=NODE_NO_ENCONTRADO
  echo Necesitas Node.js previamente instalado.
  pause
  exit /b 1
)
if not exist "node_modules\@libsql\client" (
  echo ERROR=DEPENDENCIAS_NO_INCLUIDAS
  echo Descarga el paquete completo de GitHub Actions.
  pause
  exit /b 1
)
node.exe "lab\start-local-v404.js"
echo RESULTADO=LAB_DETENIDO
pause
