const http = require('http');
const express = require('express');
const cors = require('cors');
const compression = require('compression');
const { WebSocketServer } = require('ws');
const bcrypt = require('bcryptjs');
const { pool, initDatabase } = require('./database');
const {
  generateAccessToken,
  generateRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  requireAdmin
} = require('./auth');

// Время в ответах API — всегда МСК/Минск (UTC+3)
// БД хранит время в московском (сессия SET timezone = 'Europe/Moscow', CURRENT_TIMESTAMP даёт МСК)
// Просто форматируем сохранённое значение и добавляем +03:00
const CREATED_AT_MSK_SQL = "to_char(t.created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS\"+03:00\"') as created_at";
const TRANSACTION_SELECT_MSK = `t.id, t.client_id, t.amount, t.discount, t.final_amount, ${CREATED_AT_MSK_SQL}, t.operation_type, t.replacement_of_transaction_id, t.payment_method, t.cash_part, t.card_part, t.created_by_user`;
// Для таблицы clients (без алиаса)
const CREATED_AT_MSK_CLIENT_SQL = "to_char(created_at, 'YYYY-MM-DD\"T\"HH24:MI:SS\"+03:00\"') as created_at";

/** Сумма покупок клиента (total_spent): только продажи, без возвратов и зачислений на счёт. */
const CLIENT_SALES_OPERATION_SQL = `COALESCE(operation_type, 'sale') NOT IN ('return', 'topup')`;

const GOLD_THRESHOLD_BYN = 500;

function toMoneyCents(value) {
  return Math.round((Number(value) || 0) * 100);
}

/** Статус GOLD: накопленные покупки ≥ 500 и/или остаток на счёте зачислений ≥ 500 */
function clientQualifiesForGold(totalSpent, accountBalance) {
  const thresholdCents = GOLD_THRESHOLD_BYN * 100;
  const spentCents = toMoneyCents(totalSpent);
  const balanceCents = toMoneyCents(accountBalance);
  return spentCents >= thresholdCents || balanceCents >= thresholdCents;
}

function resolveClientStatusAfterSpend(totalSpent, accountBalance) {
  if (clientQualifiesForGold(totalSpent, accountBalance)) return 'gold';
  return 'standart';
}

/** Точка «Червенский» для админа: отчёт и создание продаж (переопределение: REPORT_TABLE_ADMIN_POINT_ID). */
function getAdminChervenskiyPointId() {
  const raw = process.env.REPORT_TABLE_ADMIN_POINT_ID;
  const n = raw != null && raw !== '' ? parseInt(raw, 10) : 1;
  return Number.isFinite(n) ? n : 1;
}

// Точка вкладки «Таблица»: сотрудник — только своя точка; admin — всегда Червенский.
function getReportTablePointId(req) {
  if (req.user?.role === 'admin') {
    return getAdminChervenskiyPointId();
  }
  const pid = req.user?.pointId;
  if (pid == null || pid === '') return null;
  const n = typeof pid === 'number' ? pid : parseInt(String(pid), 10);
  return Number.isFinite(n) ? n : null;
}

// Точки продаж: для user — только своя точка, для admin — опционально query.pointId или все
function getPointFilter(req) {
  if (req.user?.role === 'admin') {
    const q = req.query.pointId;
    if (q !== undefined && q !== '' && q !== null) {
      const id = parseInt(q, 10);
      if (!Number.isNaN(id)) return { pointId: id, isAdmin: true };
    }
    return { pointId: null, isAdmin: true };
  }
  return { pointId: req.user?.pointId ?? null, isAdmin: false };
}

// point_id при создании транзакции: user — своя точка; admin — всегда Червенский (см. getAdminChervenskiyPointId)
async function getPointIdForInsert(req) {
  if (req.user?.role === 'admin') {
    return getAdminChervenskiyPointId();
  }
  return req.user?.pointId ?? null;
}

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(compression());
app.use(cors({
  origin: '*',
  credentials: true
}));
// Лимит тела запроса (base64-изображения до 5 МБ укладываются в ~7 МБ)
app.use(express.json({ limit: '8mb' }));
app.use(express.urlencoded({ limit: '8mb', extended: true }));

// Инициализация базы данных при старте (будет выполнена перед запуском сервера)

// Маршрут для входа
app.post('/api/auth/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    // Поиск админа в базе с названием точки (если есть)
    const result = await pool.query(
      `SELECT a.id, a.username, a.password, a.role, a.point_id, p.name as point_name
       FROM admins a
       LEFT JOIN points p ON a.point_id = p.id
       WHERE a.username = $1`,
      [username]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const admin = result.rows[0];

    // Проверка пароля
    const validPassword = await bcrypt.compare(password, admin.password);
    if (!validPassword) {
      return res.status(401).json({ error: 'Неверный логин или пароль' });
    }

    const role = admin.role || 'user';
    const pointId = admin.point_id != null ? admin.point_id : null;
    const pointName = admin.point_name || null;
    const accessToken = generateAccessToken(admin.id, admin.username, role, pointId);
    const refreshToken = generateRefreshToken(admin.id, admin.username);

    res.json({
      accessToken,
      refreshToken,
      user: {
        id: admin.id,
        username: admin.username,
        role: admin.role || 'user',
        pointId: pointId,
        pointName: pointName
      }
    });
  } catch (error) {
    console.error('Ошибка входа:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Список точек продаж (для админа — выбор точки в фильтрах)
app.get('/api/points', verifyAccessToken, async (req, res) => {
  try {
    res.set('Cache-Control', 'private, max-age=60');
    const result = await pool.query('SELECT id, name FROM points ORDER BY id');
    res.json(result.rows);
  } catch (error) {
    console.error('Ошибка получения точек:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Маршрут для обновления access токена
app.post('/api/auth/refresh', async (req, res) => {
  try {
    const { refreshToken } = req.body;
    if (!refreshToken) {
      return res.status(401).json({ error: 'Refresh token отсутствует' });
    }
    const decoded = verifyRefreshToken(refreshToken);
    if (!decoded) {
      return res.status(403).json({ error: 'Refresh token недействителен' });
    }
    const adminRow = await pool.query(
      'SELECT a.role, a.point_id, p.name as point_name FROM admins a LEFT JOIN points p ON a.point_id = p.id WHERE a.id = $1',
      [decoded.userId]
    );
    const row = adminRow.rows[0];
    const role = row?.role || 'user';
    const pointId = row?.point_id != null ? row.point_id : null;
    const accessToken = generateAccessToken(decoded.userId, decoded.username, role, pointId);
    res.json({
      accessToken,
      user: row ? { pointId: pointId, pointName: row.point_name || null, role } : undefined
    });
  } catch (e) {
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Маршрут для получения всех клиентов с пагинацией
app.get('/api/clients', verifyAccessToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    let limit = parseInt(req.query.limit) || 20;
    // Максимальный лимит для безопасности
    const MAX_LIMIT = 10000;
    limit = Math.min(limit, MAX_LIMIT);
    const offset = (page - 1) * limit;
    const searchQuery = typeof req.query.search === 'string' ? req.query.search.trim() : '';

    let query = `
      SELECT 
        id,
        first_name,
        last_name,
        middle_name,
        client_id,
        status,
        total_spent,
        account_balance,
        discount_percent,
        ${CREATED_AT_MSK_CLIENT_SQL}
      FROM clients
    `;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    // Поиск по имени, фамилии, отчеству или ID
    if (searchQuery) {
      const searchPattern = `%${searchQuery}%`;
      conditions.push(`(
        first_name ILIKE $${paramIndex} OR
        last_name ILIKE $${paramIndex} OR
        middle_name ILIKE $${paramIndex} OR
        client_id ILIKE $${paramIndex} OR
        CONCAT(first_name, ' ', last_name) ILIKE $${paramIndex} OR
        CONCAT(last_name, ' ', first_name) ILIKE $${paramIndex}
      )`);
      params.push(searchPattern);
      paramIndex++;
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ` ORDER BY created_at DESC`;

    // Получаем общее количество записей
    let countQuery = `SELECT COUNT(*) as total FROM clients`;
    if (conditions.length > 0) {
      countQuery += ` WHERE ${conditions.join(' AND ')}`;
    }

    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    // Получаем данные с пагинацией
    params.push(limit, offset);
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;

    const result = await pool.query(query, params);

    res.json({
      clients: result.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Ошибка получения клиентов:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Статистика по всей БД: всего клиентов, Gold, Standart
app.get('/api/clients/stats', verifyAccessToken, async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'gold')::int AS gold,
        COUNT(*) FILTER (WHERE status IS NULL OR status != 'gold')::int AS standart
      FROM clients
    `);
    const row = result.rows[0];
    res.json({
      total: row.total,
      gold: row.gold,
      standart: row.standart
    });
  } catch (error) {
    console.error('Ошибка получения статистики клиентов:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Поиск клиентов по имени/фамилии/отчеству/ID (строка) - оптимизированный
app.get('/api/clients/search', verifyAccessToken, async (req, res) => {
  try {
    const qRaw = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (!qRaw) {
      return res.json([]);
    }

    // Базовая нормализация пробелов, поиск подстроки
    const q = qRaw.replace(/\s+/g, ' ');
    const like = `%${q}%`;

    // Оптимизированный запрос с использованием индексов
    const result = await pool.query(
      `
        SELECT 
          id,
          first_name,
          last_name,
          middle_name,
          client_id,
          status,
          total_spent,
          account_balance,
          discount_percent,
          ${CREATED_AT_MSK_CLIENT_SQL}
        FROM clients
        WHERE
          first_name ILIKE $1 OR
          last_name ILIKE $1 OR
          middle_name ILIKE $1 OR
          client_id ILIKE $1
        ORDER BY created_at DESC
        LIMIT 20
      `,
      [like]
    );

    res.json(result.rows);
  } catch (error) {
    console.error('Ошибка поиска клиентов:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Маршрут для создания нового клиента
app.post('/api/clients', verifyAccessToken, async (req, res) => {
  try {
    const rawFirstName = typeof req.body.firstName === 'string' ? req.body.firstName.trim() : '';
    const rawLastName = typeof req.body.lastName === 'string' ? req.body.lastName.trim() : '';
    const rawMiddleName = typeof req.body.middleName === 'string' ? req.body.middleName.trim() : '';
    const rawClientId = typeof req.body.clientId === 'string' ? req.body.clientId.trim().split(/\s*\|\|/)[0].trim() : '';

    const firstName = rawFirstName || 'Без имени';
    const lastName = rawLastName || 'Без фамилии';
    const middleName = rawMiddleName || null;
    const clientId = rawClientId || null;

    const priceParsed = Number.parseFloat(req.body.price);
    const price = Number.isFinite(priceParsed) ? priceParsed : 0;

    // Проверка существования клиента по ID (только если ID задан)
    if (clientId != null) {
      const existingClientById = await pool.query(
        'SELECT * FROM clients WHERE client_id = $1',
        [clientId]
      );
      if (existingClientById.rows.length > 0) {
        return res.status(400).json({ error: 'Клиент с таким ID уже существует' });
      }
    }

    // Проверка существования клиента по имени, фамилии и отчеству
    // Используем COALESCE для обработки NULL значений
    const existingClientByName = await pool.query(
      `SELECT * FROM clients 
       WHERE LOWER(TRIM(first_name)) = LOWER(TRIM($1::text)) 
       AND LOWER(TRIM(last_name)) = LOWER(TRIM($2::text)) 
       AND COALESCE(LOWER(TRIM(middle_name)), '') = COALESCE(LOWER(TRIM($3::text)), '')`,
      [firstName, lastName, middleName || '']
    );

    if (existingClientByName.rows.length > 0) {
      return res.status(400).json({ error: 'Клиент с таким именем, фамилией и отчеством уже существует' });
    }

    // Создание нового клиента.
    // Важно: история покупок хранится в `transactions`, а `total_spent` — накопительный итог.
    // Для нового клиента история ДО текущей покупки = 0, поэтому скидка на первую покупку НЕ применяется.
    const clientResult = await pool.query(`
      INSERT INTO clients (first_name, last_name, middle_name, client_id, total_spent, status)
      VALUES ($1, $2, $3, $4, $5, 'standart')
      RETURNING id, first_name, last_name, middle_name, client_id, status, total_spent, account_balance,
        to_char(created_at, 'YYYY-MM-DD"T"HH24:MI:SS"+03:00"') as created_at,
        updated_at
    `, [firstName, lastName, middleName, clientId ?? null, 0]);

    const client = clientResult.rows[0];

    // Расчет скидки и финальной суммы: приоритет у discount_percent клиента, иначе GOLD → 10%
    const status = client.status || 'standart';
    const clientDiscountPercent = Number(client.discount_percent) || 0;
    const discount = clientDiscountPercent > 0 ? clientDiscountPercent : (status === 'gold' ? 10 : 0);
    const employeeDiscount = parseFloat(req.body.employeeDiscount || 0);
    let finalAmount = Number.parseFloat(price) * (1 - discount / 100);
    finalAmount = Math.max(0, finalAmount - employeeDiscount);

    const newTotal = Number.parseFloat(client.total_spent) + Number.parseFloat(price);
    const balanceAfter = Number.parseFloat(client.account_balance) || 0;
    const newStatus = resolveClientStatusAfterSpend(newTotal, balanceAfter);
    await pool.query(
      'UPDATE clients SET total_spent = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [newTotal, newStatus, client.id]
    );
    client.total_spent = newTotal;
    client.status = newStatus;

    // Создание транзакции
    const paymentMethod = req.body.paymentMethod || 'cash';
    const cashPart = paymentMethod === 'mixed' ? parseFloat(req.body.cashPart) : null;
    const cardPart = paymentMethod === 'mixed' ? parseFloat(req.body.cardPart) : null;
    if (paymentMethod === 'mixed') {
      const sumCents = toMoneyCents(cashPart) + toMoneyCents(cardPart);
      const finalCents = toMoneyCents(finalAmount);
      if (sumCents !== finalCents) {
        return res.status(400).json({ error: 'Сумма наличными + картой должна равняться итогу заказа' });
      }
    }
    const createdByUser = req.user?.username || null;
    const pointId = await getPointIdForInsert(req);
    const transactionResult = await pool.query(`
      INSERT INTO transactions (client_id, amount, discount, final_amount, payment_method, employee_discount, created_by_user, point_id, cash_part, card_part)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
      RETURNING id
    `, [client.id, Number.parseFloat(price), discount, finalAmount, paymentMethod, employeeDiscount, createdByUser, pointId, cashPart, cardPart]);
    
    const transactionId = transactionResult.rows[0].id;
    
    // Сохранение товаров в транзакции, если они есть (при создании клиента с покупкой)
    const items = req.body.items;
    if (items && Array.isArray(items) && items.length > 0) {
      for (const item of items) {
        await pool.query(
          `INSERT INTO transaction_items (transaction_id, product_id, product_name, product_price, quantity)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            transactionId,
            item.productId || item.product_id || '',
            item.productName || item.product_name || '',
            parseFloat(item.productPrice || item.product_price || 0),
            parseInt(item.quantity || 1, 10)
          ]
        );
      }
    }

    broadcastDataUpdated();
    res.json({
      client,
      transaction: {
        amount: price,
        discount,
        finalAmount
      }
    });
  } catch (error) {
    console.error('Ошибка создания клиента:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Маршрут для добавления новой покупки
app.post('/api/clients/:id/purchase', verifyAccessToken, async (req, res) => {
  const dbClient = await pool.connect();
  try {
    await dbClient.query('BEGIN');
    
    const clientId = req.params.id;
    const { price, items, isTopUp } = req.body;

    // Получение текущего клиента
    const clientResult = await dbClient.query(
      'SELECT * FROM clients WHERE id = $1',
      [clientId]
    );

    if (clientResult.rows.length === 0) {
      await dbClient.query('ROLLBACK');
      return res.status(404).json({ error: 'Клиент не найден' });
    }

    const clientData = clientResult.rows[0];
    const priceFloat = parseFloat(price);

    // Зачисление на счёт: пишем в баланс клиента и в журнал операций (topup)
    if (isTopUp) {
      if (!Number.isFinite(priceFloat) || priceFloat <= 0) {
        await dbClient.query('ROLLBACK');
        return res.status(400).json({ error: 'Укажите сумму зачисления' });
      }
      const paymentMethodTopUp = req.body.paymentMethod || 'cash';
      const createdByUserTopUp = req.user?.username || null;
      const pointIdTopUp = await getPointIdForInsert(req);
      const prevBalance = parseFloat(clientData.account_balance) || 0;
      const newBalance = prevBalance + priceFloat;
      const spent = parseFloat(clientData.total_spent) || 0;
      const newStatusTopUp = resolveClientStatusAfterSpend(spent, newBalance);
      await dbClient.query(
        'UPDATE clients SET account_balance = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [newBalance, newStatusTopUp, clientId]
      );
      const topUpTransactionResult = await dbClient.query(
        `INSERT INTO transactions (
          client_id, amount, discount, final_amount, payment_method, employee_discount, created_by_user, point_id, cash_part, card_part, operation_type
        ) VALUES ($1, $2, 0, $2, $3, 0, $4, $5, NULL, NULL, 'topup')
        RETURNING id`,
        [clientId, priceFloat, paymentMethodTopUp, createdByUserTopUp, pointIdTopUp]
      );
      const topUpTransactionId = topUpTransactionResult.rows[0].id;
      await dbClient.query('COMMIT');
      broadcastDataUpdated();
      return res.json({
        client: {
          ...clientData,
          account_balance: newBalance,
          status: newStatusTopUp
        },
        transaction: {
          id: topUpTransactionId,
          amount: priceFloat,
          discount: 0,
          finalAmount: priceFloat,
          operationType: 'topup'
        }
      });
    }

    const currentTotal = parseFloat(clientData.total_spent) || 0;
    const currentBalance = parseFloat(clientData.account_balance) || 0;

    // Расчет новой общей суммы (только сумма, уже учтённая в БД)
    const newTotal = currentTotal + priceFloat;

    // Скидка: приоритет у discount_percent клиента, иначе GOLD → 10%
    const newStatus = resolveClientStatusAfterSpend(newTotal, currentBalance);
    const clientDiscountPercent = Number(clientData.discount_percent) || 0;
    const discount = clientDiscountPercent > 0 ? clientDiscountPercent : (newStatus === 'gold' ? 10 : 0);
    const employeeDiscount = parseFloat(req.body.employeeDiscount || 0);
    let finalAmount = priceFloat * (1 - discount / 100);
    finalAmount = Math.max(0, finalAmount - employeeDiscount);

    // Обновление клиента: total_spent и статус (gold при сумме покупок ≥ 500 или счёте ≥ 500)
    await dbClient.query(
      'UPDATE clients SET total_spent = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
      [newTotal, newStatus, clientId]
    );

    // Создание транзакции
    const paymentMethod = req.body.paymentMethod || 'cash';
    const cashPart = paymentMethod === 'mixed' ? parseFloat(req.body.cashPart) : null;
    const cardPart = paymentMethod === 'mixed' ? parseFloat(req.body.cardPart) : null;
    if (paymentMethod === 'mixed') {
      const sumCents = toMoneyCents(cashPart) + toMoneyCents(cardPart);
      const finalCents = toMoneyCents(finalAmount);
      if (sumCents !== finalCents) {
        await dbClient.query('ROLLBACK');
        return res.status(400).json({ error: 'Сумма наличными + картой должна равняться итогу заказа' });
      }
    }
    const createdByUser = req.user?.username || null;
    const pointId = await getPointIdForInsert(req);
    const operationType = isTopUp ? 'topup' : 'sale';
    const transactionResult = await dbClient.query(
      'INSERT INTO transactions (client_id, amount, discount, final_amount, payment_method, employee_discount, created_by_user, point_id, cash_part, card_part, operation_type) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id',
      [clientId, priceFloat, discount, finalAmount, paymentMethod, employeeDiscount, createdByUser, pointId, cashPart, cardPart, 'sale']
    );

    const transactionId = transactionResult.rows[0].id;

    // Сохранение товаров в транзакции, если они есть
    if (items && Array.isArray(items) && items.length > 0) {
      for (const item of items) {
        await dbClient.query(
          `INSERT INTO transaction_items (transaction_id, product_id, product_name, product_price, quantity)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            transactionId,
            item.productId || item.product_id || '',
            item.productName || item.product_name || '',
            parseFloat(item.productPrice || item.product_price || 0),
            parseInt(item.quantity || 1, 10)
          ]
        );
      }
    }

    await dbClient.query('COMMIT');

    broadcastDataUpdated();
    res.json({
      client: {
        ...clientData,
        total_spent: newTotal,
        status: newStatus
      },
      transaction: {
        id: transactionId,
        amount: price,
        discount,
        finalAmount
      }
    });
  } catch (error) {
    await dbClient.query('ROLLBACK');
    console.error('Ошибка добавления покупки:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  } finally {
    dbClient.release();
  }
});

// Анонимная покупка (без регистрации клиента)
app.post('/api/purchases/anonymous', verifyAccessToken, async (req, res) => {
  try {
    const { price, items } = req.body;
    const priceFloat = parseFloat(price);

    if (!priceFloat || priceFloat <= 0) {
      return res.status(400).json({ error: 'Укажите сумму заказа' });
    }

    // Без скидки для анонимных заказов
    const discount = 0;
    const employeeDiscount = parseFloat(req.body.employeeDiscount || 0);
    const finalAmount = Math.max(0, priceFloat - employeeDiscount);

    const paymentMethod = req.body.paymentMethod || 'cash';
    const cashPart = paymentMethod === 'mixed' ? parseFloat(req.body.cashPart) : null;
    const cardPart = paymentMethod === 'mixed' ? parseFloat(req.body.cardPart) : null;
    if (paymentMethod === 'mixed') {
      const sumCents = toMoneyCents(cashPart) + toMoneyCents(cardPart);
      const finalCents = toMoneyCents(finalAmount);
      if (sumCents !== finalCents) {
        return res.status(400).json({ error: 'Сумма наличными + картой должна равняться итогу заказа' });
      }
    }
    const createdByUser = req.user?.username || null;
    const pointId = await getPointIdForInsert(req);
    const transactionResult = await pool.query(
      'INSERT INTO transactions (client_id, amount, discount, final_amount, payment_method, employee_discount, created_by_user, point_id, cash_part, card_part) VALUES (NULL, $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id',
      [priceFloat, discount, finalAmount, paymentMethod, employeeDiscount, createdByUser, pointId, cashPart, cardPart]
    );

    const transactionId = transactionResult.rows[0].id;

    if (items && Array.isArray(items) && items.length > 0) {
      for (const item of items) {
        await pool.query(
          `INSERT INTO transaction_items (transaction_id, product_id, product_name, product_price, quantity)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            transactionId,
            item.productId || item.product_id || '',
            item.productName || item.product_name || '',
            parseFloat(item.productPrice || item.product_price || 0),
            parseInt(item.quantity || 1, 10)
          ]
        );
      }
    }

    broadcastDataUpdated();
    res.json({
      success: true,
      transaction: {
        id: transactionId,
        amount: priceFloat,
        discount,
        finalAmount
      }
    });
  } catch (error) {
    console.error('Ошибка анонимной покупки:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ========== АДМИНКА: Управление клиентами (до /api/clients/:clientId, чтобы не перехватывать) ==========
app.get('/api/admin/clients/:id', verifyAccessToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT id, first_name, last_name, middle_name, client_id, status, total_spent, account_balance, discount_percent, ${CREATED_AT_MSK_CLIENT_SQL}, updated_at FROM clients WHERE id = $1`,
      [id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Клиент не найден' });
    }
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Ошибка получения клиента:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.put('/api/admin/clients/:id', verifyAccessToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { firstName, lastName, middleName, clientId, status } = req.body;
    const discountPercentRaw = req.body.discountPercent ?? req.body.discount_percent;
    const clientIdVal = (typeof clientId === 'string' && clientId.trim() !== '') ? clientId.trim() : null;
    const num = (discountPercentRaw !== undefined && discountPercentRaw !== null && String(discountPercentRaw).trim() !== '')
      ? parseFloat(discountPercentRaw)
      : 0;
    const discountPercentVal = Number.isFinite(num) ? Math.max(0, Math.min(100, num)) : 0;
    const result = await pool.query(
      `UPDATE clients 
       SET first_name = $1, last_name = $2, middle_name = $3, 
           client_id = $4, status = $5, discount_percent = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7 
       RETURNING *`,
      [firstName || 'Без имени', lastName || 'Без фамилии', middleName || null, clientIdVal, status || 'standart', discountPercentVal, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Клиент не найден' });
    }
    broadcastDataUpdated();
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Ошибка редактирования клиента:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

app.delete('/api/admin/clients/:id', verifyAccessToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query('DELETE FROM clients WHERE id = $1 RETURNING *', [id]);
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Клиент не найден' });
    }
    broadcastDataUpdated();
    res.json({ success: true, message: 'Клиент удален' });
  } catch (error) {
    console.error('Ошибка удаления клиента:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Маршрут для получения информации о клиенте (по client_id, не по id)
app.get('/api/clients/:clientId', verifyAccessToken, async (req, res) => {
  try {
    let { clientId } = req.params;
    clientId = (clientId || '').trim().split(/\s*\|\|/)[0].trim();
    if (!clientId) {
      return res.status(200).json(null);
    }
    const normalizedId = clientId.replace(/^\+/, ''); // убираем ведущий + для поиска

    const result = await pool.query(
      `SELECT id, first_name, last_name, middle_name, client_id, status, total_spent, account_balance, discount_percent, ${CREATED_AT_MSK_CLIENT_SQL}, updated_at FROM clients WHERE client_id = $1 OR client_id = $2`,
      [clientId, normalizedId]
    );

    if (result.rows.length === 0) {
      return res.status(200).json(null);
    }

    res.json(result.rows[0]);
  } catch (error) {
    console.error('Ошибка получения клиента:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Маршрут для получения статистики по способам оплаты
app.get('/api/purchases/payment-stats', verifyAccessToken, async (req, res) => {
  try {
    const dateFrom = req.query.dateFrom || null;
    const dateTo = req.query.dateTo || null;
    const { pointId } = getPointFilter(req);

    const saleOnly = "COALESCE(operation_type, 'sale') NOT IN ('return', 'topup')";
    let query = `
      SELECT 
        COALESCE(SUM(final_amount) FILTER (WHERE payment_method = 'cash'), 0)
          + COALESCE(SUM(cash_part) FILTER (WHERE payment_method = 'mixed'), 0) as cash_total,
        COALESCE(SUM(final_amount) FILTER (WHERE payment_method = 'card'), 0)
          + COALESCE(SUM(card_part) FILTER (WHERE payment_method = 'mixed'), 0) as card_total,
        COALESCE(COUNT(*) FILTER (WHERE payment_method = 'cash'), 0)
          + COALESCE(COUNT(*) FILTER (WHERE payment_method = 'mixed' AND COALESCE(cash_part, 0) >= COALESCE(card_part, 0)), 0) as cash_count,
        COALESCE(COUNT(*) FILTER (WHERE payment_method = 'card'), 0)
          + COALESCE(COUNT(*) FILTER (WHERE payment_method = 'mixed' AND COALESCE(card_part, 0) > COALESCE(cash_part, 0)), 0) as card_count
      FROM transactions
    `;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (pointId != null) {
      conditions.push(`point_id = $${paramIndex}`);
      params.push(pointId);
      paramIndex++;
    }

    if (dateFrom) {
      conditions.push(`DATE(created_at) >= $${paramIndex}`);
      params.push(dateFrom);
      paramIndex++;
    }

    if (dateTo) {
      conditions.push(`DATE(created_at) <= $${paramIndex}`);
      params.push(dateTo);
      paramIndex++;
    }

    conditions.push(CLIENT_SALES_OPERATION_SQL);

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    const result = await pool.query(query, params);
    const stats = result.rows[0];

    const cashCount = parseInt(stats.cash_count || 0);
    const cardCount = parseInt(stats.card_count || 0);
    res.json({
      cash: {
        total: parseFloat(stats.cash_total || 0),
        count: cashCount
      },
      card: {
        total: parseFloat(stats.card_total || 0),
        count: cardCount
      },
      total: {
        total: parseFloat(stats.cash_total || 0) + parseFloat(stats.card_total || 0),
        count: cashCount + cardCount
      }
    });
  } catch (error) {
    console.error('Ошибка получения статистики по способам оплаты:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Маршрут для получения статистики продаж по товарам (только напитки, исключая пачки кофе и турки)
app.get('/api/orders/stats/products', verifyAccessToken, async (req, res) => {
  try {
    const dateFrom = req.query.dateFrom || null;
    const dateTo = req.query.dateTo || null;
    const { pointId } = getPointFilter(req);

    let query = `
      SELECT 
        ti.product_name,
        SUM(ti.quantity) as total_quantity,
        SUM((ti.product_price * ti.quantity) * COALESCE(t.final_amount / NULLIF(t.amount, 0), 1)) as total_revenue,
        SUM(ti.product_price * ti.quantity) as total_without_discount,
        COUNT(DISTINCT ti.transaction_id) as order_count
      FROM transaction_items ti
      INNER JOIN transactions t ON ti.transaction_id = t.id
      WHERE COALESCE(t.operation_type, 'sale') NOT IN ('return', 'topup')
        AND (
          ti.product_name NOT ILIKE '%пачка%'
          AND ti.product_name NOT ILIKE '%турка%'
          AND ti.product_name NOT ILIKE '%упаковка%'
          AND ti.product_name NOT ILIKE '%кг%'
          AND ti.product_name NOT ILIKE '%гр%'
          AND ti.product_name NOT ILIKE '%1000%'
          AND ti.product_name NOT ILIKE '%500%'
          AND ti.product_name NOT ILIKE '%250%'
          AND ti.product_name NOT ILIKE '%кофе фасованный%'
          AND ti.product_name NOT ILIKE '%кофе в зернах%'
        )
        AND ti.product_id ~ '^[0-9]+$'
        AND EXISTS (
          SELECT 1 FROM products p_chart
          INNER JOIN product_subcategories ps_chart ON p_chart.subcategory_id = ps_chart.id
          INNER JOIN product_categories pc_chart ON ps_chart.category_id = pc_chart.id
          WHERE p_chart.id = CAST(ti.product_id AS INTEGER) AND pc_chart.track_charts = true
        )
    `;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (pointId != null) {
      conditions.push(`t.point_id = $${paramIndex}`);
      params.push(pointId);
      paramIndex++;
    }

    if (dateFrom) {
      conditions.push(`DATE(t.created_at) >= $${paramIndex}`);
      params.push(dateFrom);
      paramIndex++;
    }

    if (dateTo) {
      conditions.push(`DATE(t.created_at) <= $${paramIndex}`);
      params.push(dateTo);
      paramIndex++;
    }

    if (conditions.length > 0) {
      query += ` AND ${conditions.join(' AND ')}`;
    }

    query += `
      GROUP BY ti.product_name
      ORDER BY total_quantity DESC
    `;

    const result = await pool.query(query, params);
    const totalWithoutDiscount = result.rows.reduce((s, r) => s + parseFloat(r.total_without_discount || 0), 0);

    res.json({
      products: result.rows.map(row => ({
        name: row.product_name,
        quantity: parseInt(row.total_quantity || 0),
        revenue: parseFloat(row.total_revenue || 0),
        orderCount: parseInt(row.order_count || 0)
      })),
      totalWithoutDiscount
    });
  } catch (error) {
    console.error('Ошибка получения статистики по товарам:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Маршрут для получения статистики продаж по категориям товаров
app.get('/api/orders/stats/categories', verifyAccessToken, async (req, res) => {
  try {
    const dateFrom = req.query.dateFrom || null;
    const dateTo = req.query.dateTo || null;
    const categoryId = req.query.categoryId || null;
    const { pointId } = getPointFilter(req);

    let query = `
      SELECT 
        pc.id as category_id,
        pc.name as category_name,
        SUM(ti.quantity) as total_quantity,
        SUM((ti.product_price * ti.quantity) * COALESCE(t.final_amount / NULLIF(t.amount, 0), 1)) as total_revenue,
        SUM(ti.product_price * ti.quantity) as total_without_discount,
        COUNT(DISTINCT ti.transaction_id) as order_count
      FROM transaction_items ti
      INNER JOIN transactions t ON ti.transaction_id = t.id
      LEFT JOIN products p ON (
        CASE 
          WHEN ti.product_id ~ '^[0-9]+$' THEN CAST(ti.product_id AS INTEGER) = p.id
          ELSE false
        END
      )
      LEFT JOIN product_subcategories ps ON p.subcategory_id = ps.id
      LEFT JOIN product_categories pc ON ps.category_id = pc.id
      WHERE COALESCE(t.operation_type, 'sale') NOT IN ('return', 'topup')
        AND pc.id IS NOT NULL
        AND pc.track_charts = true
    `;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (pointId != null) {
      conditions.push(`t.point_id = $${paramIndex}`);
      params.push(pointId);
      paramIndex++;
    }

    if (categoryId) {
      conditions.push(`pc.id = $${paramIndex}`);
      params.push(categoryId);
      paramIndex++;
    }

    if (dateFrom) {
      conditions.push(`DATE(t.created_at) >= $${paramIndex}`);
      params.push(dateFrom);
      paramIndex++;
    }

    if (dateTo) {
      conditions.push(`DATE(t.created_at) <= $${paramIndex}`);
      params.push(dateTo);
      paramIndex++;
    }

    if (conditions.length > 0) {
      query += ` AND ${conditions.join(' AND ')}`;
    }

    query += `
      GROUP BY pc.id, pc.name
      ORDER BY total_quantity DESC
    `;

    const result = await pool.query(query, params);
    const totalWithoutDiscount = result.rows.reduce((s, r) => s + parseFloat(r.total_without_discount || 0), 0);

    res.json({
      categories: result.rows.map(row => ({
        id: row.category_id,
        name: row.category_name,
        quantity: parseInt(row.total_quantity || 0),
        revenue: parseFloat(row.total_revenue || 0),
        orderCount: parseInt(row.order_count || 0)
      })),
      totalWithoutDiscount
    });
  } catch (error) {
    console.error('Ошибка получения статистики по категориям:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Маршрут для получения статистики продаж по конкретному товару
app.get('/api/orders/stats/product', verifyAccessToken, async (req, res) => {
  try {
    const dateFrom = req.query.dateFrom || null;
    const dateTo = req.query.dateTo || null;
    const productId = req.query.productId || null;
    const productName = req.query.productName || null;
    const { pointId } = getPointFilter(req);

    if (!productId && !productName) {
      return res.status(400).json({ error: 'Необходимо указать productId или productName' });
    }

    let query = `
      SELECT 
        ti.product_name,
        ti.product_id,
        SUM(ti.quantity) as total_quantity,
        SUM((ti.product_price * ti.quantity) * COALESCE(t.final_amount / NULLIF(t.amount, 0), 1)) as total_revenue,
        COUNT(DISTINCT ti.transaction_id) as order_count,
        DATE(t.created_at) as sale_date
      FROM transaction_items ti
      INNER JOIN transactions t ON ti.transaction_id = t.id
      WHERE COALESCE(t.operation_type, 'sale') NOT IN ('return', 'topup')
        AND ti.product_id ~ '^[0-9]+$'
        AND EXISTS (
          SELECT 1 FROM products p_chart
          INNER JOIN product_subcategories ps_chart ON p_chart.subcategory_id = ps_chart.id
          INNER JOIN product_categories pc_chart ON ps_chart.category_id = pc_chart.id
          WHERE p_chart.id = CAST(ti.product_id AS INTEGER) AND pc_chart.track_charts = true
        )
    `;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (pointId != null) {
      conditions.push(`t.point_id = $${paramIndex}`);
      params.push(pointId);
      paramIndex++;
    }

    if (productId) {
      conditions.push(`ti.product_id = $${paramIndex}`);
      params.push(productId);
      paramIndex++;
    } else if (productName) {
      conditions.push(`ti.product_name = $${paramIndex}`);
      params.push(productName);
      paramIndex++;
    }

    if (dateFrom) {
      conditions.push(`DATE(t.created_at) >= $${paramIndex}`);
      params.push(dateFrom);
      paramIndex++;
    }

    if (dateTo) {
      conditions.push(`DATE(t.created_at) <= $${paramIndex}`);
      params.push(dateTo);
      paramIndex++;
    }

    if (conditions.length > 0) {
      query += ` AND ${conditions.join(' AND ')}`;
    }

    query += `
      GROUP BY ti.product_name, ti.product_id, DATE(t.created_at)
      ORDER BY sale_date ASC
    `;

    const result = await pool.query(query, params);
    
    res.json({
      product: {
        name: result.rows[0]?.product_name || productName || '',
        id: result.rows[0]?.product_id || productId || '',
        totalQuantity: result.rows.reduce((sum, row) => sum + parseInt(row.total_quantity || 0), 0),
        totalRevenue: result.rows.reduce((sum, row) => sum + parseFloat(row.total_revenue || 0), 0),
        totalOrderCount: result.rows.reduce((sum, row) => sum + parseInt(row.order_count || 0), 0),
        dailyStats: result.rows.map(row => ({
          date: row.sale_date,
          quantity: parseInt(row.total_quantity || 0),
          revenue: parseFloat(row.total_revenue || 0),
          orderCount: parseInt(row.order_count || 0)
        }))
      }
    });
  } catch (error) {
    console.error('Ошибка получения статистики по товару:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Константа цветов для графиков
const COLORS = ['#ef4444', '#22c55e', '#3b82f6', '#f59e0b', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

// Маршрут для получения продаж за неделю (по дням)
// dateFrom, dateTo — опционально; если не указаны — последние 7 дней
app.get('/api/orders/stats/weekly-sales', verifyAccessToken, async (req, res) => {
  try {
    const { pointId } = getPointFilter(req);
    const dateFrom = req.query.dateFrom || null;
    const dateTo = req.query.dateTo || null;

    const useRange = dateFrom && dateTo;
    const params = [];
    if (pointId != null) params.push(pointId);
    if (useRange) params.push(dateFrom, dateTo);

    const daysSeries = useRange
      ? `generate_series($${pointId != null ? 2 : 1}::date, $${pointId != null ? 3 : 2}::date, '1 day'::interval)`
      : `generate_series(CURRENT_DATE - interval '6 days', CURRENT_DATE, '1 day'::interval)`;
    const salesFilter = useRange
      ? `AND DATE(t.created_at) >= $${pointId != null ? 2 : 1} AND DATE(t.created_at) <= $${pointId != null ? 3 : 2}`
      : `AND DATE(t.created_at) >= CURRENT_DATE - interval '6 days' AND DATE(t.created_at) <= CURRENT_DATE`;

    const query = `
      WITH days AS (
        SELECT d::date as day FROM ${daysSeries} d
      ),
      sales AS (
        SELECT DATE(t.created_at) as day, COALESCE(SUM(t.final_amount), 0) as total, COUNT(*) as count
        FROM transactions t
        WHERE COALESCE(t.operation_type, 'sale') NOT IN ('return', 'topup') ${salesFilter}
          ${pointId != null ? 'AND t.point_id = $1' : ''}
        GROUP BY DATE(t.created_at)
      )
      SELECT d.day::text as date, COALESCE(s.total, 0)::float as total, COALESCE(s.count, 0)::int as count
      FROM days d LEFT JOIN sales s ON d.day = s.day
      ORDER BY d.day ASC
    `;

    const result = await pool.query(query, params);

    res.json({
      days: result.rows.map(r => ({
        date: r.date,
        total: parseFloat(r.total || 0),
        count: parseInt(r.count || 0, 10)
      })),
      dateFrom: useRange ? dateFrom : undefined,
      dateTo: useRange ? dateTo : undefined
    });
  } catch (error) {
    console.error('Ошибка получения продаж за неделю:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Маршрут для получения топ товаров за конкретный день
app.get('/api/orders/stats/day-top-products', verifyAccessToken, async (req, res) => {
  try {
    const date = req.query.date || null;
    const limit = parseInt(req.query.limit) || 5;
    const categoryId = req.query.categoryId || null;
    const { pointId } = getPointFilter(req);

    if (!date) {
      return res.status(400).json({ error: 'Необходимо указать дату' });
    }

    let query = `
      SELECT 
        ti.product_name,
        ti.product_id,
        SUM(ti.quantity) as total_quantity,
        SUM((ti.product_price * ti.quantity) * COALESCE(t.final_amount / NULLIF(t.amount, 0), 1)) as total_revenue,
        COUNT(DISTINCT ti.transaction_id) as order_count
      FROM transaction_items ti
      INNER JOIN transactions t ON ti.transaction_id = t.id
      WHERE COALESCE(t.operation_type, 'sale') NOT IN ('return', 'topup')
        AND DATE(t.created_at) = $1
        AND ti.product_id ~ '^[0-9]+$'
        AND EXISTS (
          SELECT 1 FROM products p_chart
          INNER JOIN product_subcategories ps_chart ON p_chart.subcategory_id = ps_chart.id
          INNER JOIN product_categories pc_chart ON ps_chart.category_id = pc_chart.id
          WHERE p_chart.id = CAST(ti.product_id AS INTEGER) AND pc_chart.track_charts = true
        )
    `;

    const params = [date];
    let paramIndex = 2;

    if (pointId != null) {
      query += ` AND t.point_id = $${paramIndex}`;
      params.push(pointId);
      paramIndex++;
    }

    if (categoryId) {
      query += ` AND EXISTS (
        SELECT 1 FROM products p
        LEFT JOIN product_subcategories ps ON p.subcategory_id = ps.id
        LEFT JOIN product_categories pc ON ps.category_id = pc.id
        WHERE (
          CASE 
            WHEN ti.product_id ~ '^[0-9]+$' THEN CAST(ti.product_id AS INTEGER) = p.id
            ELSE false
          END
        ) AND pc.id = $${paramIndex} AND pc.track_charts = true
      )`;
      params.push(categoryId);
      paramIndex++;
    }

    query += `
      GROUP BY ti.product_name, ti.product_id
      ORDER BY total_revenue DESC
      LIMIT $${paramIndex}
    `;
    params.push(limit);

    const result = await pool.query(query, params);
    
    // Вычисляем общую сумму для расчета процентов
    const totalRevenue = result.rows.reduce((sum, row) => sum + parseFloat(row.total_revenue || 0), 0);
    
    const products = result.rows.map((row, index) => {
      const revenue = parseFloat(row.total_revenue || 0);
      const percentage = totalRevenue > 0 ? (revenue / totalRevenue * 100) : 0;
      return {
        name: row.product_name,
        id: row.product_id,
        quantity: parseInt(row.total_quantity || 0),
        revenue: revenue,
        percentage: parseFloat(percentage.toFixed(1)),
        orderCount: parseInt(row.order_count || 0),
        color: COLORS[index % COLORS.length]
      };
    });
    
    res.json({
      date: date,
      totalRevenue: totalRevenue,
      products: products
    });
  } catch (error) {
    console.error('Ошибка получения топ товаров за день:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Маршрут для получения статистики продаж по товарам конкретной категории
app.get('/api/orders/stats/category-products', verifyAccessToken, async (req, res) => {
  try {
    const dateFrom = req.query.dateFrom || null;
    const dateTo = req.query.dateTo || null;
    const categoryId = req.query.categoryId || null;
    const { pointId } = getPointFilter(req);

    if (!categoryId) {
      return res.status(400).json({ error: 'Необходимо указать categoryId' });
    }

    let query = `
      SELECT 
        ti.product_name,
        ti.product_id,
        SUM(ti.quantity) as total_quantity,
        SUM((ti.product_price * ti.quantity) * COALESCE(t.final_amount / NULLIF(t.amount, 0), 1)) as total_revenue,
        COUNT(DISTINCT ti.transaction_id) as order_count
      FROM transaction_items ti
      INNER JOIN transactions t ON ti.transaction_id = t.id
      LEFT JOIN products p ON (
        CASE 
          WHEN ti.product_id ~ '^[0-9]+$' THEN CAST(ti.product_id AS INTEGER) = p.id
          ELSE false
        END
      )
      LEFT JOIN product_subcategories ps ON p.subcategory_id = ps.id
      LEFT JOIN product_categories pc ON ps.category_id = pc.id
      WHERE COALESCE(t.operation_type, 'sale') NOT IN ('return', 'topup')
        AND pc.id = $1
        AND pc.track_charts = true
    `;

    const params = [categoryId];
    let paramIndex = 2;

    if (pointId != null) {
      query += ` AND t.point_id = $${paramIndex}`;
      params.push(pointId);
      paramIndex++;
    }

    if (dateFrom) {
      query += ` AND DATE(t.created_at) >= $${paramIndex}`;
      params.push(dateFrom);
      paramIndex++;
    }

    if (dateTo) {
      query += ` AND DATE(t.created_at) <= $${paramIndex}`;
      params.push(dateTo);
      paramIndex++;
    }

    query += `
      GROUP BY ti.product_name, ti.product_id
      ORDER BY total_quantity DESC
    `;

    const result = await pool.query(query, params);

    res.json({
      products: result.rows.map(row => ({
        name: row.product_name,
        id: row.product_id,
        quantity: parseInt(row.total_quantity || 0),
        revenue: parseFloat(row.total_revenue || 0),
        orderCount: parseInt(row.order_count || 0)
      }))
    });
  } catch (error) {
    console.error('Ошибка получения статистики по товарам категории:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Маршрут для получения истории покупок с фильтрацией по дате и пагинацией
app.get('/api/purchases', verifyAccessToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 20;
    const offset = (page - 1) * limit;
    const dateFrom = req.query.dateFrom || null;
    const dateTo = req.query.dateTo || null;
    const searchName = typeof req.query.searchName === 'string' ? req.query.searchName.trim() : '';
    const { pointId } = getPointFilter(req);

    let query = `
      SELECT 
        t.id,
        t.client_id,
        t.amount,
        t.discount,
        t.final_amount,
        t.employee_discount,
        ${CREATED_AT_MSK_SQL},
        t.operation_type,
        t.payment_method,
        t.cash_part,
        t.card_part,
        t.created_by_user,
        c.first_name,
        c.last_name,
        c.middle_name,
        c.client_id as client_external_id,
        c.status as client_status,
        c.discount_percent as client_discount_percent
      FROM transactions t
      LEFT JOIN clients c ON t.client_id = c.id
    `;

    const conditions = [];
    const params = [];
    let paramIndex = 1;

    if (pointId != null) {
      conditions.push(`t.point_id = $${paramIndex}`);
      params.push(pointId);
      paramIndex++;
    }

    if (dateFrom) {
      conditions.push(`DATE(t.created_at) >= $${paramIndex}`);
      params.push(dateFrom);
      paramIndex++;
    }

    if (dateTo) {
      conditions.push(`DATE(t.created_at) <= $${paramIndex}`);
      params.push(dateTo);
      paramIndex++;
    }

    if (searchName) {
      const searchPattern = `%${searchName}%`;
      const isAnonSearch = /^ано$|аноним|anonymous/i.test(searchName.trim());
      conditions.push(`(
        (c.first_name ILIKE $${paramIndex} OR
        c.last_name ILIKE $${paramIndex} OR
        c.middle_name ILIKE $${paramIndex} OR
        c.client_id::text ILIKE $${paramIndex} OR
        CONCAT(COALESCE(c.first_name,''), ' ', COALESCE(c.last_name,'')) ILIKE $${paramIndex} OR
        CONCAT(COALESCE(c.last_name,''), ' ', COALESCE(c.first_name,'')) ILIKE $${paramIndex})
        ${isAnonSearch ? ' OR t.client_id IS NULL' : ''}
        OR EXISTS (
          SELECT 1 FROM transaction_items ti2
          LEFT JOIN products p ON (CASE WHEN ti2.product_id ~ '^[0-9]+$' THEN CAST(ti2.product_id AS INTEGER) = p.id ELSE false END)
          LEFT JOIN product_subcategories ps ON p.subcategory_id = ps.id
          LEFT JOIN product_categories pc ON ps.category_id = pc.id
          WHERE ti2.transaction_id = t.id
          AND (ti2.product_name ILIKE $${paramIndex} OR pc.name ILIKE $${paramIndex})
        )
      )`);
      params.push(searchPattern);
      paramIndex++;
    }

    if (conditions.length > 0) {
      query += ` WHERE ${conditions.join(' AND ')}`;
    }

    query += ` ORDER BY t.created_at DESC`;

    // Получаем общее количество записей
    let countQuery = `
      SELECT COUNT(*) as total
      FROM transactions t
      LEFT JOIN clients c ON t.client_id = c.id
    `;
    if (conditions.length > 0) {
      countQuery += ` WHERE ${conditions.join(' AND ')}`;
    }

    const countResult = await pool.query(countQuery, params);
    const total = parseInt(countResult.rows[0].total);

    // Получаем данные с пагинацией
    params.push(limit, offset);
    query += ` LIMIT $${paramIndex} OFFSET $${paramIndex + 1}`;

    const result = await pool.query(query, params);

    res.json({
      purchases: result.rows,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit)
      }
    });
  } catch (error) {
    console.error('Ошибка получения истории покупок:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получение деталей покупки (для истории покупок)
app.get('/api/purchases/:id', verifyAccessToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT ${TRANSACTION_SELECT_MSK}, t.employee_discount, t.point_id, c.first_name, c.last_name, c.middle_name, c.client_id as client_external_id, c.status as client_status, c.discount_percent as client_discount_percent
       FROM transactions t
       LEFT JOIN clients c ON t.client_id = c.id
       WHERE t.id = $1`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Покупка не найдена' });
    }

    const purchaseRow = result.rows[0];
    if (req.user?.role !== 'admin' && purchaseRow.point_id != null && purchaseRow.point_id !== req.user?.pointId) {
      return res.status(403).json({ error: 'Доступ запрещён' });
    }
    
    // Получаем товары для этой транзакции
    const itemsResult = await pool.query(
      `SELECT product_id, product_name, product_price, quantity
       FROM transaction_items
       WHERE transaction_id = $1
       ORDER BY id`,
      [id]
    );
    
    const purchase = purchaseRow;
    purchase.items = itemsResult.rows;

    // Связанный заказ: для возврата — замена; для замены — возвращённый заказ
    const opType = (purchase.operation_type || 'sale').toLowerCase();
    if (opType === 'return' && purchase.id) {
      const repl = await pool.query(
        `SELECT ${TRANSACTION_SELECT_MSK}, t.employee_discount, c.first_name, c.last_name, c.middle_name, c.client_id as client_external_id, c.status as client_status, c.discount_percent as client_discount_percent
         FROM transactions t
         LEFT JOIN clients c ON t.client_id = c.id
         WHERE t.replacement_of_transaction_id = $1`,
        [purchase.id]
      );
      if (repl.rows.length > 0) {
        const replItems = await pool.query(
          'SELECT product_id, product_name, product_price, quantity FROM transaction_items WHERE transaction_id = $1 ORDER BY id',
          [repl.rows[0].id]
        );
        purchase.replacement_transaction = { ...repl.rows[0], items: replItems.rows };
      }
    } else if (opType === 'replacement' && purchase.replacement_of_transaction_id) {
      const ret = await pool.query(
        `SELECT ${TRANSACTION_SELECT_MSK}, t.employee_discount, c.first_name, c.last_name, c.middle_name, c.client_id as client_external_id, c.status as client_status, c.discount_percent as client_discount_percent
         FROM transactions t
         LEFT JOIN clients c ON t.client_id = c.id
         WHERE t.id = $1`,
        [purchase.replacement_of_transaction_id]
      );
      if (ret.rows.length > 0) {
        const retItems = await pool.query(
          'SELECT product_id, product_name, product_price, quantity FROM transaction_items WHERE transaction_id = $1 ORDER BY id',
          [ret.rows[0].id]
        );
        purchase.return_transaction = { ...ret.rows[0], items: retItems.rows };
      }
    }

    res.json(purchase);
  } catch (error) {
    console.error('Ошибка получения деталей покупки:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Оформление замены: обновить тот же заказ (товары и сумму), без новой записи в истории
app.post('/api/purchases/replacement', verifyAccessToken, async (req, res) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { return_transaction_id: returnTransactionId, price, items } = req.body;

    if (!returnTransactionId || !Number(returnTransactionId)) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Укажите ID заказа для замены' });
    }

    const priceFloat = parseFloat(price);
    if (!Number.isFinite(priceFloat) || priceFloat <= 0) {
      await client.query('ROLLBACK');
      return res.status(400).json({ error: 'Укажите корректную сумму заказа' });
    }

    const origResult = await client.query(
      'SELECT * FROM transactions WHERE id = $1',
      [returnTransactionId]
    );
    if (origResult.rows.length === 0) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Заказ не найден' });
    }
    const original = origResult.rows[0];
    if (req.user?.role !== 'admin' && original.point_id != null && original.point_id !== req.user?.pointId) {
      await client.query('ROLLBACK');
      return res.status(403).json({ error: 'Доступ запрещён' });
    }
    const clientId = original.client_id;

    let discount = 0;
    if (clientId != null) {
      const clientRow = (await client.query('SELECT status, discount_percent FROM clients WHERE id = $1', [clientId])).rows[0];
      const status = clientRow?.status || 'standart';
      const clientDiscountPercent = Number(clientRow?.discount_percent) || 0;
      discount = clientDiscountPercent > 0 ? clientDiscountPercent : (status === 'gold' ? 10 : 0);
    }
    const finalAmount = priceFloat * (1 - discount / 100);

    // Обновить тот же заказ: сумма и оставляем operation_type как продажа
    await client.query(
      `UPDATE transactions SET amount = $1, discount = $2, final_amount = $3, operation_type = COALESCE(NULLIF(operation_type, 'return'), 'sale')
       WHERE id = $4`,
      [priceFloat, discount, finalAmount, returnTransactionId]
    );

    // Удалить старые позиции и вставить новые
    await client.query('DELETE FROM transaction_items WHERE transaction_id = $1', [returnTransactionId]);

    if (items && Array.isArray(items) && items.length > 0) {
      for (const item of items) {
        await client.query(
          `INSERT INTO transaction_items (transaction_id, product_id, product_name, product_price, quantity)
           VALUES ($1, $2, $3, $4, $5)`,
          [
            returnTransactionId,
            item.productId || item.product_id || '',
            item.productName || item.product_name || '',
            parseFloat(item.productPrice || item.product_price || 0),
            parseInt(item.quantity || 1, 10)
          ]
        );
      }
    }

    // Пересчитать total_spent только для заказов с клиентом
    if (clientId != null) {
      const sumResult = await client.query(
        `SELECT COALESCE(SUM(amount), 0) AS total FROM transactions WHERE client_id = $1 AND ${CLIENT_SALES_OPERATION_SQL}`,
        [clientId]
      );
      const newTotal = parseFloat(sumResult.rows[0].total);
      const statusRow = (
        await client.query('SELECT account_balance, status FROM clients WHERE id = $1', [clientId])
      ).rows[0];
      const newClientStatus = resolveClientStatusAfterSpend(
        newTotal,
        parseFloat(statusRow.account_balance) || 0
      );
      await client.query(
        'UPDATE clients SET total_spent = $1, status = $2, updated_at = CURRENT_TIMESTAMP WHERE id = $3',
        [newTotal, newClientStatus, clientId]
      );
    }

    await client.query('COMMIT');

    const updatedOrder = await pool.query(
      `SELECT t.*, c.first_name, c.last_name, c.middle_name, c.client_id as client_external_id, c.status as client_status, c.discount_percent as client_discount_percent
       FROM transactions t
       LEFT JOIN clients c ON t.client_id = c.id
       WHERE t.id = $1`,
      [returnTransactionId]
    );
    const updatedRow = updatedOrder.rows[0];
    const updatedItems = await pool.query(
      'SELECT product_id, product_name, product_price, quantity FROM transaction_items WHERE transaction_id = $1 ORDER BY id',
      [returnTransactionId]
    );
    updatedRow.items = updatedItems.rows;

    res.json({
      success: true,
      transaction: updatedRow
    });
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    console.error('Ошибка оформления замены:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  } finally {
    client.release();
  }
});

// Пометка покупки как возврат или замена
app.patch('/api/purchases/:id', verifyAccessToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { operation_type: operationType } = req.body;
    
    if (!['return', 'replacement', 'sale'].includes(operationType)) {
      return res.status(400).json({ error: 'Недопустимый тип операции. Допустимо: return, replacement, sale' });
    }
    
    const checkResult = await pool.query('SELECT id, point_id FROM transactions WHERE id = $1', [id]);
    if (checkResult.rows.length === 0) {
      return res.status(404).json({ error: 'Покупка не найдена' });
    }
    const row = checkResult.rows[0];
    if (req.user?.role !== 'admin' && row.point_id != null && row.point_id !== req.user?.pointId) {
      return res.status(403).json({ error: 'Доступ запрещён' });
    }
    
    await pool.query(
      'UPDATE transactions SET operation_type = $1 WHERE id = $2',
      [operationType, id]
    );
    
    const updated = await pool.query(
      `SELECT t.*, c.first_name, c.last_name, c.middle_name, c.client_id as client_external_id, c.status as client_status, c.discount_percent as client_discount_percent
       FROM transactions t
       LEFT JOIN clients c ON t.client_id = c.id
       WHERE t.id = $1`,
      [id]
    );
    
    const purchase = updated.rows[0];
    const itemsResult = await pool.query(
      'SELECT product_id, product_name, product_price, quantity FROM transaction_items WHERE transaction_id = $1 ORDER BY id',
      [id]
    );
    purchase.items = itemsResult.rows;
    
    res.json(purchase);
  } catch (error) {
    console.error('Ошибка пометки покупки:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ========== АДМИНКА: Управление транзакциями ==========

// Удаление транзакции
app.delete('/api/admin/transactions/:id', verifyAccessToken, async (req, res) => {
  try {
    const { id } = req.params;
    
    // Получаем транзакцию для пересчета total_spent клиента
    const transactionResult = await pool.query('SELECT * FROM transactions WHERE id = $1', [id]);
    
    if (transactionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Транзакция не найдена' });
    }
    
    const transaction = transactionResult.rows[0];
    
    // Удаляем транзакцию
    await pool.query('DELETE FROM transactions WHERE id = $1', [id]);
    
    // Пересчитываем aggregate-поля клиента только для клиентских транзакций
    if (transaction.client_id != null) {
      const clientTransactions = await pool.query(
        `SELECT SUM(amount) as total FROM transactions WHERE client_id = $1 AND ${CLIENT_SALES_OPERATION_SQL}`,
        [transaction.client_id]
      );
      const newTotal = parseFloat(clientTransactions.rows[0].total || 0);
      const statusRowDel = (
        await pool.query('SELECT account_balance, status FROM clients WHERE id = $1', [transaction.client_id])
      ).rows[0];
      if (statusRowDel) {
        let newBalanceDel = parseFloat(statusRowDel.account_balance) || 0;
        if ((transaction.operation_type || 'sale') === 'topup') {
          newBalanceDel = Math.max(0, newBalanceDel - (parseFloat(transaction.final_amount) || 0));
        }
        const newClientStatusDel = resolveClientStatusAfterSpend(
          newTotal,
          newBalanceDel
        );
        await pool.query(
          'UPDATE clients SET total_spent = $1, account_balance = $2, status = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4',
          [newTotal, newBalanceDel, newClientStatusDel, transaction.client_id]
        );
      }
    }

    broadcastDataUpdated();
    res.json({ success: true, message: 'Транзакция удалена' });
  } catch (error) {
    console.error('Ошибка удаления транзакции:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Редактирование транзакции
app.put('/api/admin/transactions/:id', verifyAccessToken, async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, discount } = req.body;
    
    // Получаем текущую транзакцию
    const transactionResult = await pool.query('SELECT * FROM transactions WHERE id = $1', [id]);
    
    if (transactionResult.rows.length === 0) {
      return res.status(404).json({ error: 'Транзакция не найдена' });
    }
    
    const transaction = transactionResult.rows[0];
    const newAmount = parseFloat(amount || transaction.amount);
    const newDiscount = parseFloat(discount !== undefined ? discount : transaction.discount);
    const newFinalAmount = newDiscount > 0 ? newAmount * (1 - newDiscount / 100) : newAmount;
    
    // Обновляем транзакцию
    await pool.query(
      'UPDATE transactions SET amount = $1, discount = $2, final_amount = $3 WHERE id = $4',
      [newAmount, newDiscount, newFinalAmount, id]
    );
    
    // Пересчитываем aggregate-поля клиента только для клиентских транзакций
    if (transaction.client_id != null) {
      const clientTransactions = await pool.query(
        `SELECT SUM(amount) as total FROM transactions WHERE client_id = $1 AND ${CLIENT_SALES_OPERATION_SQL}`,
        [transaction.client_id]
      );
      const newTotal = parseFloat(clientTransactions.rows[0].total || 0);
      const statusRowPut = (
        await pool.query('SELECT account_balance, status FROM clients WHERE id = $1', [transaction.client_id])
      ).rows[0];
      if (statusRowPut) {
        let newBalancePut = parseFloat(statusRowPut.account_balance) || 0;
        if ((transaction.operation_type || 'sale') === 'topup') {
          const prevTopupAmount = parseFloat(transaction.final_amount) || 0;
          newBalancePut = Math.max(0, newBalancePut - prevTopupAmount + newFinalAmount);
        }
        const newClientStatusPut = resolveClientStatusAfterSpend(
          newTotal,
          newBalancePut
        );
        await pool.query(
          'UPDATE clients SET total_spent = $1, account_balance = $2, status = $3, updated_at = CURRENT_TIMESTAMP WHERE id = $4',
          [newTotal, newBalancePut, newClientStatusPut, transaction.client_id]
        );
      }
    }

    const updatedTransaction = await pool.query('SELECT * FROM transactions WHERE id = $1', [id]);
    broadcastDataUpdated();
    res.json(updatedTransaction.rows[0]);
  } catch (error) {
    console.error('Ошибка редактирования транзакции:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получение транзакции по ID
app.get('/api/admin/transactions/:id', verifyAccessToken, async (req, res) => {
  try {
    const { id } = req.params;
    const result = await pool.query(
      `SELECT t.*, c.first_name, c.last_name, c.middle_name, c.client_id as client_external_id, c.status as client_status, c.discount_percent as client_discount_percent
       FROM transactions t
       JOIN clients c ON t.client_id = c.id
       WHERE t.id = $1`,
      [id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Транзакция не найдена' });
    }
    
    // Получаем товары для этой транзакции
    const itemsResult = await pool.query(
      `SELECT product_id, product_name, product_price, quantity
       FROM transaction_items
       WHERE transaction_id = $1
       ORDER BY id`,
      [id]
    );
    
    const transaction = result.rows[0];
    transaction.items = itemsResult.rows;
    
    res.json(transaction);
  } catch (error) {
    console.error('Ошибка получения транзакции:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ========== Дерево товаров для оформления заказа ==========

app.get('/api/products/tree', verifyAccessToken, async (req, res) => {
  try {
    res.set('Cache-Control', 'private, max-age=60');
    const categoriesResult = await pool.query(
      'SELECT id, name, icon, display_order, track_charts FROM product_categories ORDER BY display_order, id'
    );
    const categories = categoriesResult.rows;
    const categoryIds = categories.map(c => c.id);
    if (categoryIds.length === 0) {
      return res.json({ categories: [] });
    }
    const subcategoriesResult = await pool.query(
      'SELECT id, name, display_order, category_id FROM product_subcategories WHERE category_id = ANY($1::int[]) ORDER BY display_order, id',
      [categoryIds]
    );
    const subcategoriesByCategory = new Map();
    for (const sub of subcategoriesResult.rows) {
      const list = subcategoriesByCategory.get(sub.category_id) || [];
      list.push(sub);
      subcategoriesByCategory.set(sub.category_id, list);
    }
    const subcategoryIds = subcategoriesResult.rows.map(s => s.id);
    let productsBySubcategory = new Map();
    if (subcategoryIds.length > 0) {
      const productsResult = await pool.query(
        'SELECT id, name, price, image_data, display_order, tags, subcategory_id FROM products WHERE subcategory_id = ANY($1::int[]) ORDER BY display_order, id',
        [subcategoryIds]
      );
      for (const p of productsResult.rows) {
        const list = productsBySubcategory.get(p.subcategory_id) || [];
        list.push(p);
        productsBySubcategory.set(p.subcategory_id, list);
      }
    }
    const tree = categories.map(cat => {
      const subcategories = (subcategoriesByCategory.get(cat.id) || []).sort(
        (a, b) => (Number(a.display_order) - Number(b.display_order)) || (a.id - b.id)
      );
      const subcategoriesTree = subcategories.map(sub => {
        const products = productsBySubcategory.get(sub.id) || [];
        return {
          id: sub.id,
          name: sub.name,
          display_order: sub.display_order,
          products: products.map(p => ({
            id: p.id,
            name: p.name,
            price: parseFloat(p.price),
            image_data: p.image_data || null,
            tags: p.tags ? p.tags.split(',').filter(t => t.trim()) : []
          }))
        };
      });
      return {
        id: cat.id,
        name: cat.name,
        icon: cat.icon || null,
        display_order: cat.display_order,
        track_charts: !!cat.track_charts,
        subcategories: subcategoriesTree
      };
    });
    res.json({ categories: tree });
  } catch (error) {
    console.error('Ошибка получения дерева товаров:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ========== Поиск заказов по товару ==========
app.get('/api/orders/search', verifyAccessToken, async (req, res) => {
  try {
    const { productName, startDate, endDate, createdByUser } = req.query;
    const { pointId } = getPointFilter(req);
    
    if (!productName || !startDate || !endDate) {
      return res.status(400).json({ error: 'Необходимо указать productName, startDate и endDate' });
    }

    const params = [`%${productName}%`, startDate, endDate];
    let paramIndex = 4;
    const pointCondition = pointId != null ? ` AND t.point_id = $${paramIndex++}` : '';
    const createdCondition = createdByUser ? ` AND t.created_by_user = $${paramIndex++}` : '';
    if (pointId != null) params.push(pointId);
    if (createdByUser) params.push(createdByUser);

    const query = `
      SELECT DISTINCT
        t.id,
        t.client_id,
        t.amount,
        t.discount,
        t.final_amount,
        t.payment_method,
        t.cash_part,
        t.card_part,
        t.employee_discount,
        t.created_by_user,
        t.created_at,
        c.first_name,
        c.last_name,
        c.middle_name,
        c.client_id as client_identifier,
        c.status as client_status,
        c.discount_percent as client_discount_percent,
        (
          SELECT json_agg(
            json_build_object(
              'product_name', ti.product_name,
              'product_price', ti.product_price,
              'quantity', ti.quantity
            )
          )
          FROM transaction_items ti
          WHERE ti.transaction_id = t.id
        ) as items
      FROM transactions t
      LEFT JOIN clients c ON t.client_id = c.id
      WHERE EXISTS (
        SELECT 1
        FROM transaction_items ti
        WHERE ti.transaction_id = t.id
        AND LOWER(ti.product_name) LIKE LOWER($1)
      )
      AND t.created_at >= $2::date
      AND t.created_at < ($3::date + INTERVAL '1 day')
      ${pointCondition}
      ${createdCondition}
      ORDER BY t.created_at DESC
    `;

    const result = await pool.query(query, params);
    
    res.json(result.rows);
  } catch (error) {
    console.error('Ошибка поиска заказов:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ========== АДМИНКА: Управление товарами ==========

// Получение всех категорий
app.get('/api/admin/products/categories', verifyAccessToken, async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM product_categories ORDER BY display_order, id');
    res.json(result.rows);
  } catch (error) {
    console.error('Ошибка получения категорий:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Создание категории
app.post('/api/admin/products/categories', verifyAccessToken, requireAdmin, async (req, res) => {
  try {
    const { name, color, icon, displayOrder, trackCharts } = req.body;
    const result = await pool.query(
      `INSERT INTO product_categories (name, color, icon, display_order, track_charts)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [name, color || '#000000', icon || null, displayOrder || 0, !!trackCharts]
    );
    broadcastDataUpdated();
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Ошибка создания категории:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Редактирование категории
app.put('/api/admin/products/categories/:id', verifyAccessToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, color, icon, displayOrder, trackCharts } = req.body;
    const result = await pool.query(
      `UPDATE product_categories 
       SET name = $1, color = $2, icon = $3, display_order = $4, track_charts = COALESCE($5, track_charts), updated_at = CURRENT_TIMESTAMP
       WHERE id = $6
       RETURNING *`,
      [name, color, icon, displayOrder, trackCharts !== undefined ? !!trackCharts : null, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Категория не найдена' });
    }
    
    broadcastDataUpdated();
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Ошибка редактирования категории:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удаление категории
app.delete('/api/admin/products/categories/:id', verifyAccessToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM product_categories WHERE id = $1', [id]);
    broadcastDataUpdated();
    res.json({ success: true, message: 'Категория удалена' });
  } catch (error) {
    console.error('Ошибка удаления категории:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получение подкатегорий по категории
app.get('/api/admin/products/categories/:categoryId/subcategories', verifyAccessToken, async (req, res) => {
  try {
    const { categoryId } = req.params;
    const result = await pool.query(
      'SELECT * FROM product_subcategories WHERE category_id = $1 ORDER BY display_order, id',
      [categoryId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Ошибка получения подкатегорий:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Создание подкатегории
app.post('/api/admin/products/subcategories', verifyAccessToken, requireAdmin, async (req, res) => {
  try {
    const { categoryId, name, displayOrder, includeInReportTable } = req.body;
    const result = await pool.query(
      `INSERT INTO product_subcategories (category_id, name, display_order, include_in_report_table)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [categoryId, name, displayOrder || 0, !!includeInReportTable]
    );
    broadcastDataUpdated();
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Ошибка создания подкатегории:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Редактирование подкатегории
app.put('/api/admin/products/subcategories/:id', verifyAccessToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, displayOrder, includeInReportTable } = req.body;
    const result = await pool.query(
      `UPDATE product_subcategories 
       SET name = $1, display_order = $2, include_in_report_table = $3, updated_at = CURRENT_TIMESTAMP
       WHERE id = $4
       RETURNING *`,
      [name, displayOrder, !!includeInReportTable, id]
    );
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Подкатегория не найдена' });
    }
    broadcastDataUpdated();
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Ошибка редактирования подкатегории:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Удаление подкатегории
app.delete('/api/admin/products/subcategories/:id', verifyAccessToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM product_subcategories WHERE id = $1', [id]);
    broadcastDataUpdated();
    res.json({ success: true, message: 'Подкатегория удалена' });
  } catch (error) {
    console.error('Ошибка удаления подкатегории:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

/** Ключ строки остатков — как на фронте (reportBalanceStorageKey), иначе после перезагрузки значения «теряются» */
function reportBalanceRowKey(row) {
  const sid = parseInt(row.subcategory_id, 10);
  const name = String(row.product_name ?? '').trim();
  const p = Number(row.price);
  const priceNum = Number.isFinite(p) ? Math.round(p * 100) / 100 : 0;
  return `${Number.isFinite(sid) ? sid : 0}-${name}-${priceNum}`;
}

// Таблица отчёта по подкатегориям (вкладка «Таблица») — у каждой точки свои продажи и остатки; admin — данные Червенского
app.get('/api/report-table', verifyAccessToken, async (req, res) => {
  try {
    const pointId = getReportTablePointId(req);
    if (pointId == null) {
      return res.status(403).json({ error: 'Нет привязки к точке продаж' });
    }
    const dateParam = req.query.date; // YYYY-MM-DD — один день
    const dateFromParam = req.query.dateFrom; // YYYY-MM-DD — начало периода
    const dateToParam = req.query.dateTo; // YYYY-MM-DD — конец периода
    const subcatsResult = await pool.query(
      `SELECT ps.id, ps.name
       FROM product_subcategories ps
       INNER JOIN product_categories pc ON pc.id = ps.category_id
       WHERE COALESCE(ps.include_in_report_table, false) = true
       ORDER BY ps.display_order, ps.id`
    );
    const paymentLabel = (pm) => {
      if (pm === 'card') return 'Карта';
      if (pm === 'cash') return 'Наличка';
      if (pm === 'mixed') return 'Смешанная оплата';
      return pm || '—';
    };
    const mapRow = (r) => {
      const price = parseFloat(r.product_price) || 0;
      const qty = parseInt(r.quantity, 10) || 0;
      const lineBeforeDiscount = price * qty;
      const tAmount = parseFloat(r.t_amount) || 0;
      const tFinal = parseFloat(r.t_final_amount) || 0;
      const coef = tAmount > 0 && Number.isFinite(tFinal / tAmount) ? tFinal / tAmount : 1;
      const discountedAmount = Number.isFinite(lineBeforeDiscount * coef) ? lineBeforeDiscount * coef : lineBeforeDiscount;
      const isMixed = (r.payment_method || '').toLowerCase() === 'mixed';
      const cashPart = parseFloat(r.cash_part) || 0;
      const cardPart = parseFloat(r.card_part) || 0;
      const cashRatio = isMixed && tFinal > 0 && Number.isFinite(cashPart / tFinal) ? cashPart / tFinal : (r.payment_method === 'cash' ? 1 : 0);
      const cardRatio = isMixed && tFinal > 0 && Number.isFinite(cardPart / tFinal) ? cardPart / tFinal : (r.payment_method === 'card' ? 1 : 0);
      return {
        productName: r.product_name,
        price,
        paymentType: paymentLabel(r.payment_method),
        quantity: qty,
        discountedAmount,
        cashRatio,
        cardRatio
      };
    };
    const zeroRow = (product) => ({
      productName: product.name,
      price: parseFloat(product.price) || 0,
      paymentType: '',
      quantity: 0,
      discountedAmount: 0,
      cashRatio: 0,
      cardRatio: 0
    });
    const params = [pointId];
    const pointCondition = ' AND t.point_id = $1';
    let dateCondition = '';
    if (dateFromParam && dateToParam && /^\d{4}-\d{2}-\d{2}$/.test(dateFromParam) && /^\d{4}-\d{2}-\d{2}$/.test(dateToParam)) {
      params.push(dateFromParam, dateToParam);
      dateCondition = ` AND t.created_at::date >= $2::date AND t.created_at::date <= $3::date`;
    } else if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      params.push(dateParam);
      dateCondition = ` AND t.created_at::date = $2::date`;
    }
    const productsResult = await pool.query(
      `SELECT p.id, p.name, p.price, p.subcategory_id
       FROM products p
       INNER JOIN product_subcategories ps ON ps.id = p.subcategory_id
       INNER JOIN product_categories pc ON pc.id = ps.category_id
       WHERE COALESCE(ps.include_in_report_table, false) = true
       ORDER BY ps.display_order, ps.id, p.display_order, p.id`
    );
    const productsBySubcategory = new Map();
    for (const p of productsResult.rows) {
      const list = productsBySubcategory.get(p.subcategory_id) || [];
      list.push(p);
      productsBySubcategory.set(p.subcategory_id, list);
    }
    const saleOnly = "COALESCE(t.operation_type, 'sale') NOT IN ('return', 'topup')";
    const salesResult = await pool.query(
      `SELECT
          p.id AS product_id,
          p.subcategory_id,
          ti.product_name,
          ti.product_price,
          ti.quantity,
          t.payment_method,
          t.amount AS t_amount,
          t.final_amount AS t_final_amount,
          t.cash_part,
          t.card_part
       FROM transaction_items ti
       INNER JOIN transactions t ON ti.transaction_id = t.id
       INNER JOIN products p ON ti.product_id ~ '^[0-9]+$' AND p.id = CAST(ti.product_id AS INTEGER)
       INNER JOIN product_subcategories ps ON ps.id = p.subcategory_id
       INNER JOIN product_categories pc ON pc.id = ps.category_id
       WHERE ${saleOnly}
         AND COALESCE(ps.include_in_report_table, false) = true
         ${pointCondition}${dateCondition}
       ORDER BY t.created_at DESC`,
      params
    );
    const salesByProductId = new Map();
    for (const r of salesResult.rows) {
      const productId = Number(r.product_id);
      const list = salesByProductId.get(productId) || [];
      list.push(r);
      salesByProductId.set(productId, list);
    }
    const blocks = subcatsResult.rows.map(sub => {
      const products = productsBySubcategory.get(sub.id) || [];
      const rows = [];
      for (const product of products) {
        const salesRows = salesByProductId.get(Number(product.id)) || [];
        if (salesRows.length > 0) {
          rows.push(...salesRows.map(mapRow));
        } else {
          rows.push(zeroRow(product));
        }
      }
      return {
        subcategoryId: sub.id,
        subcategoryName: sub.name,
        rows
      };
    });
    let openingBalances = {};
    let periodType = null;
    let periodValue = null;
    if (
      dateFromParam &&
      dateToParam &&
      /^\d{4}-\d{2}-\d{2}$/.test(dateFromParam) &&
      /^\d{4}-\d{2}-\d{2}$/.test(dateToParam)
    ) {
      periodType = 'month';
      periodValue = dateFromParam.slice(0, 7);
    } else if (dateParam && /^\d{4}-\d{2}-\d{2}$/.test(dateParam)) {
      periodType = 'day';
      periodValue = dateParam;
    } else {
      /* «За все время» — ручные остатки хранятся с period_type=all, period_value=all */
      periodType = 'all';
      periodValue = 'all';
    }
    if (periodType && periodValue) {
      try {
        const balResult = await pool.query(
          `SELECT subcategory_id, product_name, price, quantity FROM report_opening_balance
           WHERE period_type = $1 AND period_value = $2 AND point_id = $3`,
          [periodType, periodValue, pointId]
        );
        for (const row of balResult.rows) {
          const key = reportBalanceRowKey(row);
          const qRaw = row.quantity;
          const qStr = qRaw == null ? '' : String(qRaw).trim();
          if (qStr !== '') openingBalances[key] = qStr;
        }
      } catch (e) {
        console.error('Ошибка загрузки входящих остатков:', e);
      }
    }
    let closingBalances = {};
    if (periodType && periodValue) {
      try {
        const closingResult = await pool.query(
          `SELECT subcategory_id, product_name, price, quantity FROM report_closing_balance
           WHERE period_type = $1 AND period_value = $2 AND point_id = $3`,
          [periodType, periodValue, pointId]
        );
        for (const row of closingResult.rows) {
          const key = reportBalanceRowKey(row);
          closingBalances[key] = parseInt(row.quantity, 10) || 0;
        }
      } catch (e) {
        console.error('Ошибка загрузки остатков на конец дня:', e);
      }
    }
    res.json({ blocks, openingBalances, closingBalances });
  } catch (error) {
    console.error('Ошибка получения таблицы отчёта:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Сохранение входящего остатка по товару (таблица отчёта)
app.put('/api/report-table/opening-balance', verifyAccessToken, async (req, res) => {
  try {
    const pointId = getReportTablePointId(req);
    if (pointId == null) {
      return res.status(403).json({ error: 'Нет привязки к точке продаж' });
    }
    const { periodType, periodValue, subcategoryId, productName, price, quantity } = req.body;
    if (
      periodType == null ||
      periodValue == null ||
      String(periodType).trim() === '' ||
      String(periodValue).trim() === '' ||
      subcategoryId == null ||
      !productName ||
      price == null
    ) {
      return res.status(400).json({ error: 'Не указаны periodType, periodValue, subcategoryId, productName или price' });
    }
    const numPrice = parseFloat(price);
    if (!Number.isFinite(numPrice)) {
      return res.status(400).json({ error: 'Некорректная цена' });
    }
    const subId = parseInt(subcategoryId, 10);
    const name = String(productName).trim();
    const priceNum = Math.round(numPrice * 100) / 100;
    let qStr = quantity == null ? '' : String(quantity).trim();
    if (qStr.length > 100) {
      return res.status(400).json({ error: 'Слишком длинное значение остатка (макс. 100 символов)' });
    }
    if (!Number.isFinite(subId) || !name) {
      return res.status(400).json({ error: 'Некорректные subcategoryId или productName' });
    }
    if (qStr === '') {
      await pool.query(
        `DELETE FROM report_opening_balance
         WHERE period_type = $1 AND period_value = $2 AND subcategory_id = $3 AND product_name = $4 AND price = $5 AND point_id = $6`,
        [periodType, periodValue, subId, name, priceNum, pointId]
      );
    } else {
      await pool.query(
        `INSERT INTO report_opening_balance (point_id, period_type, period_value, subcategory_id, product_name, price, quantity)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (point_id, period_type, period_value, subcategory_id, product_name, price)
         DO UPDATE SET quantity = EXCLUDED.quantity`,
        [pointId, periodType, periodValue, subId, name, priceNum, qStr]
      );
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Ошибка сохранения входящего остатка:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Сохранение остатка на конец дня по товару (таблица отчёта)
app.put('/api/report-table/closing-balance', verifyAccessToken, async (req, res) => {
  try {
    const pointId = getReportTablePointId(req);
    if (pointId == null) {
      return res.status(403).json({ error: 'Нет привязки к точке продаж' });
    }
    const { periodType, periodValue, subcategoryId, productName, price, quantity } = req.body;
    if (
      periodType == null ||
      periodValue == null ||
      String(periodType).trim() === '' ||
      String(periodValue).trim() === '' ||
      subcategoryId == null ||
      !productName ||
      price == null
    ) {
      return res.status(400).json({ error: 'Не указаны periodType, periodValue, subcategoryId, productName или price' });
    }
    const qty = parseInt(quantity, 10);
    const numPrice = parseFloat(price);
    if (!Number.isFinite(numPrice)) {
      return res.status(400).json({ error: 'Некорректная цена' });
    }
    const subId = parseInt(subcategoryId, 10);
    const name = String(productName).trim();
    const priceNum = Math.round(numPrice * 100) / 100;
    const q = Number.isNaN(qty) ? 0 : Math.max(0, qty);
    if (!Number.isFinite(subId) || !name) {
      return res.status(400).json({ error: 'Некорректные subcategoryId или productName' });
    }
    if (q === 0) {
      await pool.query(
        `DELETE FROM report_closing_balance
         WHERE period_type = $1 AND period_value = $2 AND subcategory_id = $3 AND product_name = $4 AND price = $5 AND point_id = $6`,
        [periodType, periodValue, subId, name, priceNum, pointId]
      );
    } else {
      const upd = await pool.query(
        `UPDATE report_closing_balance SET quantity = $7
         WHERE period_type = $1 AND period_value = $2 AND subcategory_id = $3 AND product_name = $4 AND price = $5 AND point_id = $6`,
        [periodType, periodValue, subId, name, priceNum, pointId, q]
      );
      if (upd.rowCount === 0) {
        try {
          await pool.query(
            `INSERT INTO report_closing_balance (point_id, period_type, period_value, subcategory_id, product_name, price, quantity)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            [pointId, periodType, periodValue, subId, name, priceNum, q]
          );
        } catch (insertErr) {
          if (insertErr.code === '23505') {
            await pool.query(
              `UPDATE report_closing_balance SET quantity = $7
               WHERE period_type = $1 AND period_value = $2 AND subcategory_id = $3 AND product_name = $4 AND price = $5 AND point_id = $6`,
              [periodType, periodValue, subId, name, priceNum, pointId, q]
            );
          } else {
            throw insertErr;
          }
        }
      }
    }
    res.json({ ok: true });
  } catch (error) {
    console.error('Ошибка сохранения остатка на конец дня:', error?.message || error);
    res.status(500).json({
      error: 'Ошибка сервера',
      detail: process.env.NODE_ENV !== 'production' ? (error?.message || String(error)) : undefined
    });
  }
});

// Получение товаров по подкатегории
app.get('/api/admin/products/subcategories/:subcategoryId/products', verifyAccessToken, async (req, res) => {
  try {
    const { subcategoryId } = req.params;
    const result = await pool.query(
      'SELECT * FROM products WHERE subcategory_id = $1 ORDER BY display_order, id',
      [subcategoryId]
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Ошибка получения товаров:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Создание товара
app.post('/api/admin/products', verifyAccessToken, requireAdmin, async (req, res) => {
  try {
    const { subcategoryId, name, price, description, imageUrl, imageData, displayOrder, tags } = req.body;
    
    // Валидация данных
    if (!subcategoryId) {
      return res.status(400).json({ error: 'ID подкатегории обязателен' });
    }
    
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Название товара обязательно' });
    }
    
    if (price === undefined || price === null || isNaN(parseFloat(price))) {
      return res.status(400).json({ error: 'Цена должна быть числом' });
    }
    
    // imageUrl или imageData — base64 строка для хранения в image_data
    const imageSource = imageUrl ?? imageData;
    const finalImageData = imageSource && typeof imageSource === 'string' && imageSource.length > 0 ? imageSource : null;
    const finalTags = tags && Array.isArray(tags) ? tags.join(',') : (tags || '');
    
    const result = await pool.query(
      `INSERT INTO products (subcategory_id, name, price, description, image_data, display_order, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [subcategoryId, name.trim(), parseFloat(price), description || null, finalImageData, displayOrder || 0, finalTags]
    );
    broadcastDataUpdated();
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Ошибка создания товара:', error);
    
    // Более детальная обработка ошибок
    if (error.code === '22001') {
      return res.status(400).json({ 
        error: 'Данные слишком длинные. Попробуйте уменьшить размер изображения или текста.' 
      });
    }
    
    res.status(500).json({ 
      error: error.message || 'Ошибка сервера при создании товара' 
    });
  }
});

// Редактирование товара
app.put('/api/admin/products/:id', verifyAccessToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    const { name, price, description, imageUrl, imageData, displayOrder, tags } = req.body;
    
    // Валидация данных
    if (!name || name.trim().length === 0) {
      return res.status(400).json({ error: 'Название товара обязательно' });
    }
    
    if (price === undefined || price === null || isNaN(parseFloat(price))) {
      return res.status(400).json({ error: 'Цена должна быть числом' });
    }
    
    // imageUrl или imageData — base64 строка для хранения в image_data
    const imageSource = imageUrl ?? imageData;
    const finalImageData = imageSource && typeof imageSource === 'string' && imageSource.length > 0 ? imageSource : null;
    const finalTags = tags && Array.isArray(tags) ? tags.join(',') : (tags || '');
    
    const result = await pool.query(
      `UPDATE products 
       SET name = $1, price = $2, description = $3, image_data = $4, display_order = $5, tags = $6, updated_at = CURRENT_TIMESTAMP
       WHERE id = $7
       RETURNING *`,
      [name.trim(), parseFloat(price), description || null, finalImageData, displayOrder || 0, finalTags, id]
    );
    
    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Товар не найден' });
    }
    
    broadcastDataUpdated();
    res.json(result.rows[0]);
  } catch (error) {
    console.error('Ошибка редактирования товара:', error);
    
    // Более детальная обработка ошибок
    if (error.code === '22001') {
      return res.status(400).json({ 
        error: 'Данные слишком длинные. Попробуйте уменьшить размер изображения или текста.' 
      });
    }
    
    res.status(500).json({ 
      error: error.message || 'Ошибка сервера при обновлении товара' 
    });
  }
});

// Удаление товара
app.delete('/api/admin/products/:id', verifyAccessToken, requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM products WHERE id = $1', [id]);
    broadcastDataUpdated();
    res.json({ success: true, message: 'Товар удален' });
  } catch (error) {
    console.error('Ошибка удаления товара:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// ========== Управление тикетами на удаление истории покупок ==========

// Создание тикета на удаление истории покупок (только admin)
app.post('/api/purchases/clear-history', verifyAccessToken, requireAdmin, async (req, res) => {
  try {
    // Проверяем, есть ли уже активный тикет
    const activeTicket = await pool.query(
      'SELECT * FROM deletion_tickets WHERE status = $1 ORDER BY created_at DESC LIMIT 1',
      ['pending']
    );

    if (activeTicket.rows.length > 0) {
      return res.status(400).json({ error: 'Уже существует активный тикет на удаление истории' });
    }

    // Создаем тикет на удаление через 24 часа
    const scheduledDeletionAt = new Date();
    scheduledDeletionAt.setHours(scheduledDeletionAt.getHours() + 24);

    const result = await pool.query(
      `INSERT INTO deletion_tickets (status, scheduled_deletion_at)
       VALUES ($1, $2)
       RETURNING *`,
      ['pending', scheduledDeletionAt]
    );

    res.json({
      success: true,
      ticket: result.rows[0]
    });
  } catch (error) {
    console.error('Ошибка создания тикета на удаление:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Отмена тикета на удаление (только admin)
app.post('/api/purchases/clear-history/:ticketId/cancel', verifyAccessToken, requireAdmin, async (req, res) => {
  try {
    const { ticketId } = req.params;

    const result = await pool.query(
      `UPDATE deletion_tickets 
       SET status = $1, cancelled_at = CURRENT_TIMESTAMP
       WHERE id = $2 AND status = $3
       RETURNING *`,
      ['cancelled', ticketId, 'pending']
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Тикет не найден или уже выполнен/отменен' });
    }

    res.json({
      success: true,
      ticket: result.rows[0]
    });
  } catch (error) {
    console.error('Ошибка отмены тикета:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Получение активных тикетов
app.get('/api/purchases/clear-history/tickets', verifyAccessToken, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM deletion_tickets 
       WHERE status = $1 
       ORDER BY created_at DESC`,
      ['pending']
    );

    res.json({
      tickets: result.rows
    });
  } catch (error) {
    console.error('Ошибка получения тикетов:', error);
    res.status(500).json({ error: 'Ошибка сервера' });
  }
});

// Функция для выполнения удаления истории покупок
const executeDeletion = async () => {
  try {
    // Проверяем существование таблицы перед запросом
    try {
      const tableCheck = await pool.query(`
        SELECT EXISTS (
          SELECT FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name = 'deletion_tickets'
        )
      `);
      
      if (!tableCheck.rows[0].exists) {
        // Таблица еще не создана, пропускаем выполнение
        return;
      }
    } catch (checkError) {
      // Если проверка не удалась, таблица точно не существует
      return;
    }
    
    const now = new Date();
    
    // Находим тикеты, которые должны быть выполнены
    const tickets = await pool.query(
      `SELECT * FROM deletion_tickets 
       WHERE status = $1 AND scheduled_deletion_at <= $2`,
      ['pending', now]
    );

    for (const ticket of tickets.rows) {
      const dbClient = await pool.connect();
      try {
        await dbClient.query('BEGIN');

        // Удаляем все транзакции
        await dbClient.query('DELETE FROM transactions');
        
        // Обновляем статус тикета
        await dbClient.query(
          `UPDATE deletion_tickets 
           SET status = $1, executed_at = CURRENT_TIMESTAMP
           WHERE id = $2`,
          ['executed', ticket.id]
        );

        // Обнуляем total_spent и зачисления у всех клиентов
        await dbClient.query(
          `UPDATE clients 
           SET total_spent = 0, account_balance = 0, status = 'standart', updated_at = CURRENT_TIMESTAMP`
        );

        await dbClient.query('COMMIT');
        console.log(`✅ История покупок удалена по тикету #${ticket.id}`);
      } catch (error) {
        await dbClient.query('ROLLBACK');
        console.error(`❌ Ошибка выполнения удаления для тикета #${ticket.id}:`, error);
      } finally {
        dbClient.release();
      }
    }
  } catch (error) {
    console.error('Ошибка выполнения удаления истории:', error);
  }
};

// Запускаем проверку тикетов каждую минуту
setInterval(executeDeletion, 60000); // 60000 мс = 1 минута

// HTTP-сервер для Express и WebSocket на одном порту
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

const WS_PING_INTERVAL_MS = 25000;

wss.on('connection', (ws) => {
  ws.on('error', () => {});

  const pingInterval = setInterval(() => {
    if (ws.readyState === 1) {
      ws.ping();
    }
  }, WS_PING_INTERVAL_MS);

  ws.on('close', () => {
    clearInterval(pingInterval);
  });
});

/** Рассылка всем подключённым клиентам: данные изменились, можно обновить списки */
function broadcastDataUpdated() {
  const payload = JSON.stringify({ type: 'data_updated' });
  wss.clients.forEach((client) => {
    if (client.readyState === 1) client.send(payload);
  });
}

// Инициализируем БД и только потом запускаем сервер
initDatabase()
  .then(() => {
    server.listen(PORT, '0.0.0.0', async () => {
      console.log(`🚀 Сервер запущен на порту ${PORT} (HTTP + WebSocket)`);
      setTimeout(() => {
        executeDeletion();
      }, 2000);
    });
  })
  .catch(err => {
    console.error('❌ Критическая ошибка инициализации базы данных:', err);
    console.error('❌ Сервер не может быть запущен без базы данных');
    process.exit(1);
  });
