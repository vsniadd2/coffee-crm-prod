-- Гарантируем отсутствие дублей строк остатков в таблице отчёта.
-- Ключ записи: точка + период + подкатегория + товар + цена.

CREATE UNIQUE INDEX IF NOT EXISTS uq_report_opening_balance_row
  ON report_opening_balance (point_id, period_type, period_value, subcategory_id, product_name, price);

CREATE UNIQUE INDEX IF NOT EXISTS uq_report_closing_balance_row
  ON report_closing_balance (point_id, period_type, period_value, subcategory_id, product_name, price);
