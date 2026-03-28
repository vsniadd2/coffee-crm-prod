-- Приводим модель к единому журналу операций:
-- 1) каждое новое пополнение пишется в transactions.operation_type='topup' (логика в backend/server.js),
-- 2) текущие накопленные account_balance фиксируем как "открывающий баланс" в журнале.
--
-- Исторические пополнения до внедрения могли не храниться как отдельные события,
-- поэтому точная ретроспектива по датам недоступна. Эта миграция создаёт стартовую
-- точку учёта для дальнейшей консистентности.

INSERT INTO transactions (
  client_id,
  amount,
  discount,
  final_amount,
  payment_method,
  employee_discount,
  created_by_user,
  operation_type
)
SELECT
  c.id,
  c.account_balance,
  0,
  c.account_balance,
  'cash',
  0,
  'migration:014_opening_topup_balance',
  'topup'
FROM clients c
WHERE COALESCE(c.account_balance, 0) > 0;
