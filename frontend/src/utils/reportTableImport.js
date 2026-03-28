const UTF8_BOM = '\uFEFF'

/** Парсинг одной строки CSV с учётом кавычек (разделитель , или ;) */
function parseCSVLine(line, sep = ',') {
  const out = []
  let cell = ''
  let inQuotes = false
  for (let i = 0; i < line.length; i++) {
    const c = line[i]
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cell += '"'
          i++
        } else {
          inQuotes = false
        }
      } else {
        cell += c
      }
    } else {
      if (c === '"') {
        inQuotes = true
      } else if (c === sep) {
        out.push(cell.trim())
        cell = ''
      } else {
        cell += c
      }
    }
  }
  out.push(cell.trim())
  return out
}

/** Парсинг CSV текста; возвращает массив строк (массив ячеек) */
function parseCSV(text) {
  const normalized = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
  const lines = normalized.split('\n').filter((l) => l.trim())
  if (lines.length === 0) return []
  const first = lines[0]
  const sep = first.includes(';') && !first.match(/"[^"]*,[^"]*"/) ? ';' : ','
  return lines.map((line) => parseCSVLine(line, sep))
}

/** Нормализация заголовка для сопоставления */
function norm(s) {
  return String(s ?? '')
    .replace(UTF8_BOM, '')
    .trim()
    .toLowerCase()
}

const HEADER_ALIASES = {
  subcategoryName: ['вес', 'подкатегория', 'вес/подкатегория', 'подкатегория/вес'],
  productName: ['наименование', 'товар', 'продукт', 'наименование:'],
  price: ['цена', 'цена за ед.', 'цена за ед., руб.', 'цена, руб'],
  opening: ['входящий остаток', 'входящий остаток, шт.', 'входящий остаток (шт)', 'остаток входящий'],
  closing: ['остаток на конец дня', 'остаток на конец дня, шт.', 'остаток на конец', 'остаток на конец дня (шт)', 'остаток конец']
}

function findColumnIndex(headers, field) {
  const aliases = HEADER_ALIASES[field]
  for (let i = 0; i < headers.length; i++) {
    const h = norm(headers[i])
    if (aliases.some((a) => h.includes(a) || a.includes(h))) return i
  }
  return -1
}

/**
 * Парсит сырые строки (первая — заголовки) в массив объектов для импорта остатков.
 * @param {string[][]} rows — массив строк (каждая строка — массив ячеек)
 * @returns {{ subcategoryName: string, productName: string, price: number, opening: number, closing: number }[]}
 */
function rowsToImportData(rows) {
  if (rows.length < 2) return []
  const headers = rows[0].map((c) => String(c ?? ''))
  const idxSub = findColumnIndex(headers, 'subcategoryName')
  const idxName = findColumnIndex(headers, 'productName')
  const idxPrice = findColumnIndex(headers, 'price')
  const idxOpening = findColumnIndex(headers, 'opening')
  const idxClosing = findColumnIndex(headers, 'closing')

  if (idxSub < 0 || idxName < 0 || idxPrice < 0) return []

  const result = []
  for (let r = 1; r < rows.length; r++) {
    const row = rows[r]
    if (!Array.isArray(row)) continue
    const subcategoryName = norm(row[idxSub] ?? '')
    const productName = norm(row[idxName] ?? '')
    const rawPrice = row[idxPrice]
    const price = parseFloat(String(rawPrice ?? '').replace(',', '.').replace(/\s/g, ''))
    if (!subcategoryName || !productName || !Number.isFinite(price) || price < 0) continue

    const opening = idxOpening >= 0 ? parseInt(String(row[idxOpening] ?? '0').replace(/\s/g, ''), 10) : 0
    const closing = idxClosing >= 0 ? parseInt(String(row[idxClosing] ?? '0').replace(/\s/g, ''), 10) : 0
    if (!Number.isFinite(opening)) continue
    if (!Number.isFinite(closing)) continue

    result.push({
      subcategoryName,
      productName,
      price,
      opening: Math.max(0, opening),
      closing: Math.max(0, closing)
    })
  }
  return result
}

/**
 * Парсит CSV-файл и возвращает данные для импорта остатков.
 * @param {File} file
 * @returns {Promise<{ rows: { subcategoryName, productName, price, opening, closing }[] }>}
 */
export async function parseReportTableFile(file) {
  const name = (file.name || '').toLowerCase()
  if (!name.endsWith('.csv')) {
    throw new Error('Поддерживается только формат CSV')
  }
  const text = await file.text()
  const rows = parseCSV(text)
  const data = rowsToImportData(rows)
  return { rows: data }
}
