-- Отдельный баланс зачислений (без строк в истории покупок / transactions)
ALTER TABLE clients ADD COLUMN IF NOT EXISTS account_balance DECIMAL(10, 2) DEFAULT 0 NOT NULL;

-- Раньше зачисления шли в transactions (operation_type = topup) и увеличивали total_spent на amount.
-- Переносим на account_balance и удаляем строки, чтобы не путать с продажами.
UPDATE clients c
SET account_balance = COALESCE(c.account_balance, 0) + sub.sum_topup
FROM (
  SELECT client_id, SUM(amount) AS sum_topup
  FROM transactions
  WHERE COALESCE(operation_type, 'sale') = 'topup' AND client_id IS NOT NULL
  GROUP BY client_id
) sub
WHERE c.id = sub.client_id;

UPDATE clients c
SET total_spent = GREATEST(0, COALESCE(c.total_spent, 0) - sub.sum_topup)
FROM (
  SELECT client_id, SUM(amount) AS sum_topup
  FROM transactions
  WHERE COALESCE(operation_type, 'sale') = 'topup' AND client_id IS NOT NULL
  GROUP BY client_id
) sub
WHERE c.id = sub.client_id;

DELETE FROM transactions WHERE COALESCE(operation_type, 'sale') = 'topup';
