import ExcelJS from 'exceljs'

const formatNum = (n) => {
  const num = Number(n)
  return (num === 0 || !Number.isFinite(num)) ? '' : num.toFixed(2)
}
const formatInt = (n) => (n === 0 ? '' : String(n))

const THIN_BORDER = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' }
}

/**
 * Собирает данные таблицы отчёта в массив строк для листа Excel.
 */
export function buildReportTableRows({ products, openingBalances, closingBalances, totals, openingBalanceKey, isAllTime }) {
  const headerRow = [
    'Вес',
    'Наименование',
    'Входящий остаток, шт.',
    'Цена за ед., руб.',
    'Наличные, шт.',
    'Карта, шт.',
    'Смешанная, шт.',
    'Итого продано, шт.',
    'НАЛИЧ, руб',
    'БЕЗНАЛ, руб',
    'ИТОГО, руб.',
    'Остаток на конец дня, шт.'
  ]
  const rows = [headerRow]

  for (const p of products) {
    const key = openingBalanceKey(p)
    const opening = isAllTime ? '' : String(openingBalances[key] ?? '')
    const closing = isAllTime ? '' : (closingBalances[key] ?? '')
    rows.push([
      p.subcategoryName,
      p.productName,
      opening,
      p.price,
      formatInt(p.qtyCash),
      formatInt(p.qtyCard),
      formatInt(p.qtyMixed),
      formatInt(p.totalQty),
      formatNum(p.amountCash),
      formatNum(p.amountCard),
      formatNum(p.amountTotal),
      closing
    ])
  }

  if (totals != null) {
    rows.push([
      '',
      'ИТОГО',
      '',
      '',
      totals.qtyCash ?? '',
      totals.qtyCard ?? '',
      totals.qtyMixed ?? '',
      totals.totalQty ?? '',
      totals.amountCash != null ? formatNum(totals.amountCash) : '',
      totals.amountCard != null ? formatNum(totals.amountCard) : '',
      totals.amountTotal != null ? formatNum(totals.amountTotal) : '',
      ''
    ])
  }

  return rows
}

/**
 * Скачивает таблицу отчёта как файл .xlsx с оформлением (границы, жирный заголовок и итого).
 */
export async function downloadReportTableExcel(rows, filename = 'Таблица отчёта') {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Отчёт', { views: [{ showGridLines: true }] })

  const numRows = rows.length
  const numCols = rows[0]?.length ?? 12

  for (let r = 0; r < numRows; r++) {
    const row = ws.getRow(r + 1)
    const rowData = rows[r]
    for (let c = 0; c < numCols; c++) {
      const cell = row.getCell(c + 1)
      const val = rowData[c]
      cell.value = val !== '' && val !== undefined && val !== null ? val : ''
      cell.border = THIN_BORDER
    }
  }

  // Заголовок (первая строка) — жирный и светлый фон
  for (let c = 1; c <= numCols; c++) {
    const cell = ws.getCell(1, c)
    cell.font = { bold: true }
    cell.fill = {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFE2E8F0' }
    }
    cell.alignment = { vertical: 'middle' }
  }

  // Строка ИТОГО (последняя) — жирный
  if (numRows > 1) {
    for (let c = 1; c <= numCols; c++) {
      const cell = ws.getCell(numRows, c)
      cell.font = { bold: true }
    }
  }

  // Ширины колонок (как на сайте — читаемо)
  const widths = [12, 22, 18, 14, 12, 10, 12, 16, 12, 12, 12, 22]
  for (let c = 0; c < numCols; c++) {
    ws.getColumn(c + 1).width = widths[c] ?? 12
  }

  const buffer = await wb.xlsx.writeBuffer()
  const blob = new Blob([buffer], {
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `${filename.replace(/[\\/:*?"<>|]/g, '-')}.xlsx`
  a.click()
  URL.revokeObjectURL(url)
}
