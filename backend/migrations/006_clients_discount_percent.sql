-- Процент скидки у клиента (0–100). Если задан — используется при расчёте заказа; иначе для GOLD — 10%.
ALTER TABLE clients ADD COLUMN IF NOT EXISTS discount_percent DECIMAL(5,2) DEFAULT 0;
