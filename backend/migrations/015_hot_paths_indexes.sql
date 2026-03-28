-- Индексы для ускорения частых выборок по истории, клиентам и статистике.
-- Безопасные и идемпотентные (IF NOT EXISTS).

CREATE INDEX IF NOT EXISTS idx_transactions_operation_created_at
  ON transactions (operation_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_client_operation_created
  ON transactions (client_id, operation_type, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transactions_replacement_of_transaction_id
  ON transactions (replacement_of_transaction_id);

CREATE INDEX IF NOT EXISTS idx_transactions_created_by_user_created_at
  ON transactions (created_by_user, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_transaction_items_transaction_product
  ON transaction_items (transaction_id, product_id);

CREATE INDEX IF NOT EXISTS idx_transaction_items_product_id
  ON transaction_items (product_id);
