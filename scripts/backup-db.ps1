# Бэкап БД (копирование всех данных). Запуск: из корня проекта в PowerShell: .\scripts\backup-db.ps1
# Копии сохраняются в папку backups\ в корне проекта.

$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot\..

$POSTGRES_USER = "admin"
$POSTGRES_DB = "coffee_crm"
if (Test-Path .env) {
    Get-Content .env | ForEach-Object {
        if ($_ -match '^\s*POSTGRES_USER\s*=\s*(.+)\s*$') { $POSTGRES_USER = $matches[1].Trim() }
        if ($_ -match '^\s*POSTGRES_DB\s*=\s*(.+)\s*$') { $POSTGRES_DB = $matches[1].Trim() }
    }
}

$backupsDir = "backups"
New-Item -ItemType Directory -Force -Path $backupsDir | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd_HHmmss"
$backupFile = "$backupsDir\backup_$timestamp.sql"

Write-Host "Копирование БД в $backupFile ..."
docker compose exec -T postgres pg_dump -U $POSTGRES_USER -d $POSTGRES_DB | Out-File -FilePath $backupFile -Encoding utf8
Write-Host "Готово. Бэкап: $backupFile"
