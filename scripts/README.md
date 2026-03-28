# Скрипты деплоя и бэкапа

## Обновление на сервере (после git push)

Подключитесь к серверу (SSH), перейдите в папку проекта и выполните:

```bash
cd /путь/к/coffee-crmm
bash scripts/deploy-on-server.sh
```

Скрипт по порядку:
1. **Делает бэкап БД** в папку `backups/` (файл `coffee_crm_YYYYMMDD_HHMMSS.sql`)
2. Выполняет `git pull`
3. Пересобирает и перезапускает контейнеры (`docker compose up -d --build`)

Папку `backups/` можно периодически чистить, оставляя последние несколько файлов.

---

## Только бэкап БД (без деплоя)

```bash
bash scripts/backup-db.sh
```

Дамп сохраняется в `backups/coffee_crm_YYYYMMDD_HHMMSS.sql`.

Если БД в Docker — используется `docker compose exec postgres pg_dump`.  
Если контейнер не запущен — скрипт пробует вызвать `pg_dump` с параметрами из `backend/.env`.
