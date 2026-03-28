# Обновление на сервере: копирование БД и деплой без потери данных

На сервере: **сначала копируем БД в файл**, затем тянем обновление с GitHub. Данные в БД не теряются. **Миграции применяются автоматически** при старте backend (см. `backend/database.js`).

---

## 1. Копирование базы данных (бэкап)

Сохраняем полную копию БД в файл. По умолчанию: пользователь `admin`, БД `coffee_crm`.

```bash
cd /путь/к/coffee-crmm-1

mkdir -p backups
docker compose exec -T postgres pg_dump -U admin -d coffee_crm > backups/backup_$(date +%Y%m%d_%H%M%S).sql
```

Проверка:
```bash
ls -la backups/
```

Если в `.env` другие `POSTGRES_USER` / `POSTGRES_DB`, подставьте их:
```bash
docker compose exec -T postgres pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" > backups/backup_$(date +%Y%m%d_%H%M%S).sql
```

---

## 2. Обновление с GitHub (без потери данных в БД)

Данные хранятся в Docker volume `postgres_data`. При `git pull` и пересборке контейнеров volume **не удаляется** — БД остаётся.

```bash
git pull origin main
```

(Если основная ветка `master`: `git pull origin master`.)

---

## 3. Пересборка и запуск (миграции применятся сами)

При старте backend читает папку `backend/migrations/` и применяет только **ещё не применённые** миграции (по таблице `schema_migrations`). Новые миграции из обновлённого кода подхватятся автоматически.

**Первый раз или после смены зависимостей (package.json):**
```bash
docker compose build --no-cache
docker compose up -d
```

**Обычное обновление (быстрее, используется кэш):**
```bash
docker compose build
docker compose up -d
```

Итог: данные в БД на месте, новый код и миграции — применены.

### Почему первая сборка долгая

На сервере сборка может идти 15–30 минут: скачиваются образы (node, nginx), выполняется `npm install` для frontend и backend. Это нормально при медленной сети или диске. **Следующие разы** используйте `docker compose build` без `--no-cache` — пересоберутся только изменённые слои, обновление займёт минуты.

---

## Скрипт (всё за один запуск)

В репозитории есть скрипт `scripts/server-update.sh`: копирование БД в `backups/`, затем `git pull`, пересборка и `docker compose up -d`. Миграции применятся при старте backend.

На сервере (Linux), из корня проекта:

```bash
chmod +x scripts/server-update.sh
./scripts/server-update.sh
```

Скрипт подхватывает `POSTGRES_USER` и `POSTGRES_DB` из `.env`, если файл есть.

---

## Windows (PowerShell)

В PowerShell из корня проекта (папка `coffee-crmm-1`):

```powershell
.\scripts\server-update.ps1
```

Скрипт `scripts/server-update.ps1`: создаёт бэкап БД в `backups/`, делает `git pull`, пересобирает образы и поднимает контейнеры. **БД не очищается** — данные в volume сохраняются.

Если политика выполнения блокирует скрипты:
```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

Вручную по шагам в PowerShell:
```powershell
cd C:\путь\к\coffee-crmm-1
New-Item -ItemType Directory -Force -Path backups
$bak = "backups\backup_$(Get-Date -Format 'yyyyMMdd_HHmmss').sql"
docker compose exec -T postgres pg_dump -U admin -d coffee_crm | Out-File -FilePath $bak -Encoding utf8
git pull origin main
docker compose build
docker compose up -d
```

---

## Всё одной командой вручную (после `cd` в папку проекта)

```bash
mkdir -p backups && \
docker compose exec -T postgres pg_dump -U admin -d coffee_crm > backups/backup_$(date +%Y%m%d_%H%M%S).sql && \
git pull origin main && \
docker compose build && \
docker compose up -d
```

---

## Восстановление из копии БД (если понадобится)

```bash
docker compose exec -T postgres psql -U admin -d coffee_crm < backups/backup_YYYYMMDD_HHMMSS.sql
```

Подставьте нужное имя файла из `backups/`.
