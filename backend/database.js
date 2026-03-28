/**
 * Подключение к PostgreSQL. Все долговременные данные приложения хранятся в БД:
 * клиенты, транзакции, товары, категории, админы, точки продаж, тикеты удаления.
 */
const { Pool } = require('pg');
const fs = require('fs');
const path = require('path');

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: process.env.DB_PORT || 5432,
  user: process.env.DB_USER || 'admin',
  password: process.env.DB_PASSWORD || 'admin123',
  database: process.env.DB_NAME || 'coffee_crm',
};

const pool = new Pool(dbConfig);

// Без обработчика при сбое idle-клиента (обрыв сети, перезапуск PostgreSQL) пул может
// сгенерировать необработанное событие error и процесс Node завершится — отсюда 502 у Vite.
pool.on('error', (err) => {
  console.error('[pg pool] Ошибка фонового клиента (клиент удалён из пула):', err.message || err);
});

// Устанавливаем часовой пояс для всех подключений
pool.on('connect', async (client) => {
  await client.query('SET timezone = \'Europe/Moscow\'');
});

// Запуск миграций из папки migrations/ — при каждом старте backend (docker compose up / start)
// Применяются только ещё не применённые файлы (по таблице schema_migrations).
const runMigrations = async (client) => {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name VARCHAR(255) PRIMARY KEY,
      applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )
  `);
  const migrationsDir = path.join(__dirname, 'migrations');
  if (!fs.existsSync(migrationsDir)) return;
  const files = fs.readdirSync(migrationsDir)
    .filter(f => f.endsWith('.sql'))
    .sort();
  for (const file of files) {
    const name = file;
    const existing = await client.query('SELECT 1 FROM schema_migrations WHERE name = $1', [name]);
    if (existing.rows.length > 0) continue;
    const filePath = path.join(migrationsDir, file);
    const sql = fs.readFileSync(filePath, 'utf8');
    try {
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name) VALUES ($1)', [name]);
      console.log('✅ Миграция применена:', name);
    } catch (err) {
      console.error('❌ Ошибка миграции', name, err.message);
      throw err;
    }
  }
};

/** Таблица отчёта «остаток на конец дня» — дублирует миграцию 010 на случай, если миграции не дошли до конца */
async function ensureReportClosingBalanceTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS report_closing_balance (
      id SERIAL PRIMARY KEY,
      period_type VARCHAR(10) NOT NULL,
      period_value VARCHAR(20) NOT NULL,
      subcategory_id INTEGER NOT NULL REFERENCES product_subcategories(id) ON DELETE CASCADE,
      product_name VARCHAR(500) NOT NULL,
      price NUMERIC(12,2) NOT NULL,
      quantity INTEGER NOT NULL DEFAULT 0,
      point_id INTEGER NOT NULL DEFAULT 1 REFERENCES points(id),
      UNIQUE(point_id, period_type, period_value, subcategory_id, product_name, price)
    );
  `);
  await client.query(`
    CREATE INDEX IF NOT EXISTS idx_report_closing_balance_period
      ON report_closing_balance(point_id, period_type, period_value);
  `);
}

// Инициализация: только миграции из папки migrations/ + создание начальных пользователей при пустой БД
const initDatabase = async () => {
  let client;
  try {
    client = await pool.connect();
  } catch (connectErr) {
    const isRefused = connectErr.code === 'ECONNREFUSED' || (connectErr.errors && connectErr.errors.some(e => e.code === 'ECONNREFUSED'));
    if (isRefused) {
      const host = dbConfig.host;
      const port = dbConfig.port;
      console.error('');
      console.error('❌ Не удалось подключиться к PostgreSQL по адресу ' + host + ':' + port + '.');
      console.error('   Убедитесь, что база данных запущена.');
      console.error('');
      console.error('   Варианты запуска БД:');
      console.error('   1) Из корня проекта:  docker compose up -d postgres');
      console.error('      затем запустите бэкенд:  cd backend && npm start');
      console.error('   2) Или запустите всё:  docker compose up');
      console.error('');
    }
    throw connectErr;
  }
  try {
    await runMigrations(client);
    console.log('✅ Миграции проверены, структура БД актуальна');

    await ensureReportClosingBalanceTable(client);

    // Создание начальных пользователей только при первом запуске (нет ни одного админа)
    try {
      const adminCountResult = await client.query('SELECT COUNT(*) as count FROM admins');
      const adminCount = parseInt(adminCountResult.rows[0].count, 10);
      if (adminCount === 0) {
        console.log('🔄 Первый запуск: создание начальных пользователей...');
        const { createInitialUsers } = require('./scripts/create-initial-users');
        await createInitialUsers();
      }
    } catch (userCheckError) {
      console.log('ℹ️ Проверка пользователей:', userCheckError.message);
    }
  } catch (error) {
    console.error('❌ Ошибка инициализации базы данных:', error);
    throw error;
  } finally {
    client.release();
  }
};

module.exports = { pool, initDatabase };
