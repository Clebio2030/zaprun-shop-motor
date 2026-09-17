@echo off
setlocal enabledelayedexpansion
title ZapRun Shop - Reparo do atualizador
color 0A
echo.
echo ==================================================
echo   ZAPRUN SHOP - REPARO DO ATUALIZADOR
echo ==================================================
echo.

rem Onde o Motor esta instalado. Se este arquivo estiver dentro da pasta
rem updater, usa ela; senao, o caminho padrao da instalacao.
set "PASTA=%~dp0"
if "%PASTA:~-1%"=="\" set "PASTA=%PASTA:~0,-1%"
if not exist "%PASTA%\updater.js" set "PASTA=C:\Administracao\ZapRunShop\updater"

if not exist "%PASTA%\updater.js" (
    color 0C
    echo [ERRO] Nao achei o atualizador em:
    echo        %PASTA%
    echo.
    echo Coloque este arquivo dentro da pasta "updater" do ZapRun Shop
    echo e execute de novo.
    echo.
    pause
    exit /b 1
)

echo Pasta do atualizador: %PASTA%
echo.

if exist "%PASTA%\version.json" (
    echo O arquivo version.json JA existe. Nada a criar.
) else (
    echo Criando o arquivo version.json que estava faltando...
    > "%PASTA%\version.json" echo {
    >>"%PASTA%\version.json" echo   "currentVersion": "0.0.0",
    >>"%PASTA%\version.json" echo   "lastCheckAt": null,
    >>"%PASTA%\version.json" echo   "lastUpdateAt": null,
    >>"%PASTA%\version.json" echo   "lastStatus": "never-run",
    >>"%PASTA%\version.json" echo   "lastReleaseTag": null,
    >>"%PASTA%\version.json" echo   "lastError": null
    >>"%PASTA%\version.json" echo }
    echo [OK] Arquivo criado.
)

echo.
echo Procurando o Node.js...
set "NODE=C:\Program Files\nodejs\node.exe"
if not exist "%NODE%" (
    for /f "delims=" %%i in ('where node.exe 2^>nul') do set "NODE=%%i"
)
if not exist "%NODE%" (
    color 0E
    echo [ATENCAO] Node.js nao encontrado. O arquivo foi criado mesmo assim:
    echo o proprio agendamento das 08h/19h vai atualizar sozinho.
    echo.
    pause
    exit /b 0
)

echo Rodando a atualizacao agora (pode demorar alguns minutos)...
echo.
"%NODE%" "%PASTA%\updater.js"
set "RESULTADO=%ERRORLEVEL%"
echo.
if "%RESULTADO%"=="0" (
    color 0A
    echo ==================================================
    echo   PRONTO - o Motor esta atualizado.
    echo ==================================================
) else (
    color 0E
    echo ==================================================
    echo   A atualizacao terminou com aviso (codigo %RESULTADO%^).
    echo   O arquivo foi criado; o agendamento das 08h/19h
    echo   tentara de novo sozinho.
    echo ==================================================
)
echo.
echo Log completo: %PASTA%\updater.log
echo.
pause
endlocal
