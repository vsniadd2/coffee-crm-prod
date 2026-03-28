-- Учёт подкатегории в таблице отчёта (вкладка «Таблица»)
ALTER TABLE product_subcategories ADD COLUMN IF NOT EXISTS include_in_report_table BOOLEAN DEFAULT false;
