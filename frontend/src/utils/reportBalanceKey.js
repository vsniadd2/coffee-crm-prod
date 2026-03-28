/**
 * Ключ строки для входящего/исходящего остатка в таблице отчёта.
 * Должен совпадать с формированием объекта openingBalances / closingBalances на сервере.
 * Цена нормализуется до 2 знаков — иначе float в JS даёт другую строку ключа, чем ответ API.
 */
export function reportBalanceStorageKey(subcategoryId, productName, price) {
  const sid = parseInt(String(subcategoryId), 10)
  const name = String(productName ?? '').trim()
  const p = Number(price)
  const priceNum = Number.isFinite(p) ? Math.round(p * 100) / 100 : 0
  return `${Number.isFinite(sid) ? sid : 0}-${name}-${priceNum}`
}
