-- Входящий остаток по товару для таблицы отчёта (ручное редактирование)
CREATE TABLE IF NOT EXISTS report_opening_balance (
  id SERIAL PRIMARY KEY,
  period_type VARCHAR(10) NOT NULL,
  period_value VARCHAR(20) NOT NULL,
  subcategory_id INTEGER NOT NULL REFERENCES product_subcategories(id) ON DELETE CASCADE,
  product_name VARCHAR(500) NOT NULL,
  price NUMERIC(12,2) NOT NULL,
  quantity INTEGER NOT NULL DEFAULT 0,
  UNIQUE(period_type, period_value, subcategory_id, product_name, price)
);

CREATE INDEX IF NOT EXISTS idx_report_opening_balance_period
  ON report_opening_balance(period_type, period_value);
