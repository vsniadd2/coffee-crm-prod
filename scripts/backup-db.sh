#!/bin/bash
# Бэкап БД перед обновлением. Запускать из корня проекта (на сервере или локально).
# Сохраняет дамп в backups/ с датой.
# Вариант 1: через Docker — docker compose exec postgres pg_dump
# Вариант 2: локальный pg_dump — если есть .env в backend/ или корне, подхватываем DB_*

set -e
cd "$(dirname "$0")/.."
mkdir -p backups
FILE="backups/coffee_crm_$(date +%Y%m%d_%H%M%S).sql"

if docker compose exec -T postgres pg_dump -U admin coffee_crm > "$FILE" 2>/dev/null; then
  echo "✅ Бэкап (Docker) сохранён: $FILE"
  exit 0
fi

# Если Docker не сработал — пробуем pg_dump напрямую (для сервера без docker или локально)
if [ -f backend/.env ]; then
  set -a
  source backend/.env
  set +a
fi
export PGPASSWORD="${DB_PASSWORD:-admin123}"
pg_dump -h "${DB_HOST:-localhost}" -p "${DB_PORT:-5432}" -U "${DB_USER:-admin}" "${DB_NAME:-coffee_crm}" -F p -f "$FILE" 2>/dev/null && {
  echo "✅ Бэкап (pg_dump) сохранён: $FILE"
  exit 0
}

echo "❌ Не удалось сделать бэкап. Проверьте: 1) docker compose up (postgres запущен?) 2) или установлен pg_dump и есть backend/.env"
exit 1
