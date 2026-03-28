-- Остатки таблицы отчёта разделяются по точке продаж (как продажи в transactions).
-- Существующие строки относятся к точке 1 (Червенский).

ALTER TABLE report_opening_balance
  ADD COLUMN IF NOT EXISTS point_id INTEGER REFERENCES points(id);

UPDATE report_opening_balance SET point_id = 1 WHERE point_id IS NULL;

ALTER TABLE report_opening_balance
  ALTER COLUMN point_id SET NOT NULL,
  ALTER COLUMN point_id SET DEFAULT 1;

ALTER TABLE report_opening_balance
  DROP CONSTRAINT IF EXISTS report_opening_balance_period_type_period_value_subcategory_id_product_name_price_key;

ALTER TABLE report_opening_balance
  ADD CONSTRAINT report_opening_balance_point_period_unique
  UNIQUE (point_id, period_type, period_value, subcategory_id, product_name, price);

CREATE INDEX IF NOT EXISTS idx_report_opening_balance_point_period
  ON report_opening_balance(point_id, period_type, period_value);

ALTER TABLE report_closing_balance
  ADD COLUMN IF NOT EXISTS point_id INTEGER REFERENCES points(id);

UPDATE report_closing_balance SET point_id = 1 WHERE point_id IS NULL;

ALTER TABLE report_closing_balance
  ALTER COLUMN point_id SET NOT NULL,
  ALTER COLUMN point_id SET DEFAULT 1;

ALTER TABLE report_closing_balance
  DROP CONSTRAINT IF EXISTS report_closing_balance_period_type_period_value_subcategory_id_product_name_price_key;

ALTER TABLE report_closing_balance
  ADD CONSTRAINT report_closing_balance_point_period_unique
  UNIQUE (point_id, period_type, period_value, subcategory_id, product_name, price);

CREATE INDEX IF NOT EXISTS idx_report_closing_balance_point_period
  ON report_closing_balance(point_id, period_type, period_value);
