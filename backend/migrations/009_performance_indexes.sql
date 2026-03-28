-- Индексы для ускорения запросов по точке, датам и дереву товаров
CREATE INDEX IF NOT EXISTS idx_transactions_point_id ON transactions(point_id);

CREATE INDEX IF NOT EXISTS idx_transactions_point_created ON transactions(point_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_products_subcategory_id ON products(subcategory_id);

CREATE INDEX IF NOT EXISTS idx_product_subcategories_category_id ON product_subcategories(category_id);
