/**
 * Скрипт заполнения БД клиентами (~8 страниц по 20 записей ≈ 160 клиентов).
 * Запуск: из папки backend — node scripts/seed-clients.js
 */

const { pool } = require('../database');

const PER_PAGE = 20;
const PAGES = 8;
const TOTAL = PER_PAGE * PAGES; // 160

const FIRST_NAMES = [
  'Александр', 'Дмитрий', 'Максим', 'Иван', 'Артём', 'Михаил', 'Никита', 'Егор', 'Даниил', 'Андрей',
  'Алексей', 'Сергей', 'Владимир', 'Павел', 'Роман', 'Олег', 'Денис', 'Евгений', 'Игорь', 'Кирилл',
  'Мария', 'Анна', 'Елена', 'Ольга', 'Наталья', 'Татьяна', 'Ирина', 'Екатерина', 'Светлана', 'Юлия',
  'Виктория', 'Дарья', 'Полина', 'Алина', 'Кристина', 'Валерия', 'Анастасия', 'Марина', 'Людмила', 'Вера'
];

const LAST_NAMES = [
  'Иванов', 'Петров', 'Сидоров', 'Козлов', 'Смирнов', 'Кузнецов', 'Попов', 'Васильев', 'Соколов', 'Михайлов',
  'Новиков', 'Федоров', 'Морозов', 'Волков', 'Алексеев', 'Лебедев', 'Семёнов', 'Егоров', 'Павлов', 'Козлов',
  'Степанов', 'Николаев', 'Орлов', 'Андреев', 'Макаров', 'Никитин', 'Захаров', 'Зайцев', 'Соловьёв', 'Борисов',
  'Яковлев', 'Григорьев', 'Романов', 'Воробьёв', 'Сергеев', 'Кузьмин', 'Фролов', 'Александров', 'Дмитриев', 'Королёв'
];

const MIDDLE_NAMES = [
  'Александрович', 'Дмитриевич', 'Максимович', 'Иванович', 'Артёмович', 'Михайлович', 'Сергеевич', 'Андреевич', 'Евгеньевич', 'Владимирович',
  'Александровна', 'Дмитриевна', 'Сергеевна', 'Андреевна', 'Михайловна', 'Евгеньевна', 'Владимировна', 'Ивановна', 'Николаевна', 'Павловна',
  null, null, null // иногда без отчества
];

function randomItem(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function seedClients() {
  const client = await pool.connect();
  try {
    const existing = await client.query('SELECT COUNT(*) AS c FROM clients');
    const count = parseInt(existing.rows[0].c, 10);
    console.log(`Текущее количество клиентов в БД: ${count}`);

    const toInsert = TOTAL;
    const runId = Date.now();
    console.log(`Добавляем ${toInsert} клиентов (~${PAGES} страниц по ${PER_PAGE})...`);

    let inserted = 0;
    for (let i = 0; i < toInsert; i++) {
      const clientId = `SEED-${runId}-${String(i + 1).padStart(4, '0')}`;

      const firstName = randomItem(FIRST_NAMES);
      const lastName = randomItem(LAST_NAMES);
      const middleName = randomItem(MIDDLE_NAMES);
      const status = Math.random() < 0.2 ? 'gold' : 'standart';
      const totalSpent = status === 'gold' ? randomInt(15000, 120000) : randomInt(0, 80000);
      // Баланс зачислений: у части клиентов есть остаток на счёте
      // (в БД поле account_balance имеет DEFAULT 0, поэтому если его не заполнить — будет 0 у всех)
      const hasBalance = Math.random() < 0.35;
      const accountBalance = hasBalance
        ? (status === 'gold' ? randomInt(5, 250) : randomInt(5, 120))
        : 0;

      await client.query(
        `INSERT INTO clients (first_name, last_name, middle_name, client_id, status, total_spent, account_balance)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [firstName, lastName, middleName, clientId, status, totalSpent, accountBalance]
      );
      inserted++;
      if (inserted % 50 === 0) console.log(`  добавлено ${inserted}/${toInsert}...`);
    }

    const after = await client.query('SELECT COUNT(*) AS c FROM clients');
    console.log(`Готово. Всего клиентов в БД: ${after.rows[0].c}`);
  } catch (err) {
    console.error('Ошибка:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seedClients().catch(() => process.exit(1));
