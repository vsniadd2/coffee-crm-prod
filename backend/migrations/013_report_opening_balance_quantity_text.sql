-- Входящий остаток: произвольная подпись в ячейке (+3, пусто и т.д.), не только целое число
ALTER TABLE report_opening_balance
  ALTER COLUMN quantity DROP DEFAULT;

ALTER TABLE report_opening_balance
  ALTER COLUMN quantity TYPE VARCHAR(100) USING quantity::text;
