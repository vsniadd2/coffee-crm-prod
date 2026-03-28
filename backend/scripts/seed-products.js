/**
 * Мок-данные по товарам для тестов.
 * Создаёт категории/подкатегории, если их нет, затем добавляет тестовые товары.
 * Запуск: из папки backend — node scripts/seed-products.js
 */

const { pool } = require('../database');

const PRODUCT_NAMES = [
  'Эспрессо', 'Американо', 'Капучино', 'Латте', 'Раф', 'Флэт уайт', 'Моккачино', 'Глясе',
  'Кортадо', 'Макиато', 'Айс латте', 'Айс американо', 'Фраппучино', 'Хот шоколад',
  'Чай чёрный', 'Чай зелёный', 'Чай с мятой', 'Чай фруктовый', 'Какао',
  'Сэндвич с ветчиной', 'Сэндвич с сыром', 'Круассан', 'Маффин', 'Чизкейк',
  'Печенье овсяное', 'Брауни', 'Кекс', 'Смузи ягодный', 'Свежевыжатый сок',
  'Кофе в зёрнах 250г', 'Кофе молотый 250г', 'Кофе в капсулах 10 шт',
  'Вода 0.5л', 'Вода 1л', 'Лимонад', 'Морс'
];

function randomPrice(min, max) {
  return (Math.random() * (max - min) + min).toFixed(2);
}

async function seedProducts() {
  const client = await pool.connect();
  try {
    let subcategoryIds = [];

    const existingSub = await client.query('SELECT id FROM product_subcategories ORDER BY id');
    if (existingSub.rows.length > 0) {
      subcategoryIds = existingSub.rows.map((r) => r.id);
      console.log(`Найдено подкатегорий: ${subcategoryIds.length}`);
    } else {
      console.log('Подкатегорий нет — создаём тестовые категории и подкатегории...');
      await client.query(`
        INSERT INTO product_categories (name, color, display_order) VALUES
        ('Напитки', '#8B4513', 1),
        ('Выпечка', '#D2691E', 2),
        ('Прочее', '#808080', 3)
      `);
      const cats = await client.query('SELECT id FROM product_categories ORDER BY id');
      const [drinksId, bakeryId, otherId] = cats.rows.map((r) => r.id);

      await client.query(
        `INSERT INTO product_subcategories (category_id, name, display_order) VALUES ($1, 'Кофе', 1), ($1, 'Чай', 2), ($1, 'Холодные', 3)`,
        [drinksId]
      );
      await client.query(
        `INSERT INTO product_subcategories (category_id, name, display_order) VALUES ($1, 'Сэндвичи', 1), ($1, 'Десерты', 2)`,
        [bakeryId]
      );
      await client.query(
        `INSERT INTO product_subcategories (category_id, name, display_order) VALUES ($1, 'Товары', 1)`,
        [otherId]
      );

      const sub = await client.query('SELECT id FROM product_subcategories ORDER BY id');
      subcategoryIds = sub.rows.map((r) => r.id);
      console.log(`Создано подкатегорий: ${subcategoryIds.length}`);
    }

    const existingProducts = await client.query('SELECT COUNT(*) AS c FROM products');
    const countBefore = parseInt(existingProducts.rows[0].c, 10);
    console.log(`Товаров в БД до: ${countBefore}`);

    let inserted = 0;
    for (let i = 0; i < PRODUCT_NAMES.length; i++) {
      const subId = subcategoryIds[i % subcategoryIds.length];
      const name = PRODUCT_NAMES[i];
      const price = randomPrice(2, 18);
      await client.query(
        `INSERT INTO products (subcategory_id, name, price, display_order) VALUES ($1, $2, $3, $4)`,
        [subId, name, price, i + 1]
      );
      inserted++;
    }

    const after = await client.query('SELECT COUNT(*) AS c FROM products');
    console.log(`Добавлено товаров: ${inserted}. Всего в БД: ${after.rows[0].c}`);
  } catch (err) {
    console.error('Ошибка:', err.message);
    throw err;
  } finally {
    client.release();
    await pool.end();
  }
}

seedProducts().catch(() => process.exit(1));
