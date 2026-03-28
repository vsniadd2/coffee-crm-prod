#!/bin/bash
# Обновление приложения на сервере после git push
# Запускать на сервере из корня проекта: bash scripts/deploy-on-server.sh
#
# 1) Бэкап БД в backups/
# 2) Останавливаем контейнеры (без -v, данные БД в volume сохраняются!)
# 3) git pull
# 4) Собираем и поднимаем контейнеры заново

set -e
cd "$(dirname "$0")/.."

echo "→ 1. Бэкап БД (на всякий случай)..."
bash scripts/backup-db.sh || true
echo ""

echo "→ 2. Останавливаем контейнеры..."
docker compose down
echo ""

echo "→ 3. Подтягиваем обновления из Git..."
git pull origin main 2>/dev/null || git pull
echo ""

echo "→ 4. Собираем и поднимаем контейнеры..."
docker compose up -d --build

echo "→ 5. Готово. Статус:"
docker compose ps

echo ""
echo "Миграции БД применяются при каждом старте backend. Логи: docker compose logs backend"
echo ""
echo "ВАЖНО: Никогда не используйте 'docker compose down -v' — флаг -v удалит данные БД!"
