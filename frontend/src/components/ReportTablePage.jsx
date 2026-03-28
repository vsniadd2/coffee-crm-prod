import React, { useState, useEffect, useCallback, useRef } from 'react'
import { createPortal } from 'react-dom'
import { reportTableService } from '../services/reportTableService'
import { useAuth } from '../contexts/AuthContext'
import { buildReportTableRows, downloadReportTableExcel } from '../utils/reportTableExport'
import { reportBalanceStorageKey } from '../utils/reportBalanceKey'
import './ReportTablePage.css'

const ROWS_PER_PAGE = 80

/** Агрегация по продукту: разбивка по типу оплаты (наличные/карта/смешанная). Суммы — итого со скидкой (discountedAmount). */
function aggregateByProduct(blocks) {
  const map = new Map()
  for (const block of blocks) {
    for (const row of block.rows) {
      const key = reportBalanceStorageKey(block.subcategoryId, row.productName, row.price)
      const qty = parseInt(row.quantity, 10) || 0
      const p = Number(row.price)
      const priceNum = Number.isFinite(p) ? Math.round(p * 100) / 100 : 0
      const rawDiscounted = Number(row.discountedAmount)
      const amount = Number.isFinite(rawDiscounted) ? rawDiscounted : priceNum * qty
      const pay = (row.paymentType || '').toLowerCase()
      const cashRatio = Number.isFinite(Number(row.cashRatio)) ? Number(row.cashRatio) : 0
      const cardRatio = Number.isFinite(Number(row.cardRatio)) ? Number(row.cardRatio) : 0

      if (!map.has(key)) {
        map.set(key, {
          subcategoryId: block.subcategoryId,
          subcategoryName: block.subcategoryName,
          productName: String(row.productName ?? '').trim(),
          price: priceNum,
          totalQty: 0,
          qtyCash: 0,
          qtyCard: 0,
          qtyMixed: 0,
          amountCash: 0,
          amountCard: 0,
          amountMixed: 0,
          amountTotal: 0
        })
      }
      const agg = map.get(key)
      agg.totalQty += qty
      agg.amountTotal += amount
      if (pay.includes('налич') && !pay.includes('смешан')) {
        agg.qtyCash += qty
        agg.amountCash += amount
      } else if (pay.includes('карт') && !pay.includes('смешан')) {
        agg.qtyCard += qty
        agg.amountCard += amount
      } else {
        agg.qtyMixed += qty
        agg.amountMixed += amount
        agg.amountCash += amount * cashRatio
        agg.amountCard += amount * cardRatio
      }
    }
  }
  return Array.from(map.values()).sort((a, b) =>
    a.subcategoryName.localeCompare(b.subcategoryName) || a.productName.localeCompare(b.productName)
  )
}

const formatNum = (n) => {
  const num = Number(n)
  return (num === 0 || !Number.isFinite(num)) ? '' : num.toFixed(2)
}
const formatInt = (n) => (n === 0 ? '' : String(n))

const formatDateDisplay = (dateStr) => {
  if (!dateStr) return '—'
  const [y, m, d] = dateStr.split('-').map(Number)
  return `${String(d).padStart(2, '0')}.${String(m).padStart(2, '0')}.${y}`
}

/** Входящий остаток: произвольный текст; только блокируем Enter в ячейке. */
function reportOpeningBalanceKeyDown(e) {
  if (e.key === 'Enter') e.preventDefault()
}

/** Только цифры 0–9 в ячейках «остаток на конец дня» (contentEditable) */
function reportBalanceDigitsKeyDown(e) {
  if (e.ctrlKey || e.metaKey || e.altKey) return
  if (e.key === 'Enter') {
    e.preventDefault()
    return
  }
  if (e.key.length === 1 && !/[0-9]/.test(e.key)) {
    e.preventDefault()
  }
}

function reportBalanceDigitsBeforeInput(e) {
  if (e.inputType === 'insertText' && e.data != null && e.data !== '' && !/^\d+$/.test(e.data)) {
    e.preventDefault()
  }
}

function reportBalanceDigitsPaste(e) {
  e.preventDefault()
  const raw = (e.clipboardData || window.clipboardData)?.getData('text') ?? ''
  const digits = raw.replace(/\D/g, '')
  if (!digits) return
  const sel = window.getSelection()
  if (!sel?.rangeCount) return
  const range = sel.getRangeAt(0)
  range.deleteContents()
  const node = document.createTextNode(digits)
  range.insertNode(node)
  range.setStartAfter(node)
  range.setEndAfter(node)
  range.collapse(true)
  sel.removeAllRanges()
  sel.addRange(range)
}

function reportBalanceDigitsCompositionEnd(e) {
  const el = e.currentTarget
  const cleaned = (el.textContent ?? '').replace(/\D/g, '')
  if ((el.textContent ?? '') !== cleaned) {
    el.textContent = cleaned
  }
}

const WEIGHT_COLUMN_TOOLTIP = 'Эта колонка показывает подкатегорию категории товара (например, вес упаковки или тип продукта).'

/** Синхронно с getAdminChervenskiyPointId() / REPORT_TABLE_ADMIN_POINT_ID на бэкенде (по умолчанию точка 1). */
const ADMIN_REPORT_TABLE_POINT_ID = '1'

const ReportTablePage = () => {
  const { refreshAccessToken, user } = useAuth()
  const isAdmin = user?.role === 'admin'
  const [blocks, setBlocks] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [page, setPage] = useState(1)
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [weightInfoHover, setWeightInfoHover] = useState(false)
  const [weightInfoOpen, setWeightInfoOpen] = useState(false)
  const [tooltipPos, setTooltipPos] = useState({ top: 0, left: 0 })
  const [openingBalances, setOpeningBalances] = useState({})
  const [editingOpeningBalanceKey, setEditingOpeningBalanceKey] = useState(null)
  const [openingBalanceSaveError, setOpeningBalanceSaveError] = useState(null)
  const [closingBalances, setClosingBalances] = useState({})
  const [editingClosingBalanceKey, setEditingClosingBalanceKey] = useState(null)
  const [closingBalanceSaveError, setClosingBalanceSaveError] = useState(null)
  const weightInfoRef = useRef(null)
  const openingBalanceCellRef = useRef(null)
  const closingBalanceCellRef = useRef(null)

  const effectivePointId = isAdmin
    ? ADMIN_REPORT_TABLE_POINT_ID
    : (user?.pointId != null ? String(user.pointId) : null)

  const loadReport = useCallback(async () => {
    setLoading(true)
    setError(null)
    setOpeningBalanceSaveError(null)
    setClosingBalanceSaveError(null)
    try {
      const options = {}
      if (dateFrom) options.dateFrom = dateFrom
      if (dateTo) options.dateTo = dateTo
      const data = await reportTableService.getReportTable(effectivePointId, options)
      setBlocks(data.blocks || [])
      setOpeningBalances(data.openingBalances || {})
      setClosingBalances(data.closingBalances || {})
      setPage(1)
    } catch (e) {
      if (e?.message === 'UNAUTHORIZED') {
        const ok = await refreshAccessToken()
        if (ok) return loadReport()
      }
      setError(e?.message || 'Ошибка загрузки')
    } finally {
      setLoading(false)
    }
  }, [refreshAccessToken, dateFrom, dateTo, effectivePointId])

  useEffect(() => {
    loadReport()
  }, [loadReport])

  useEffect(() => {
    if (!weightInfoOpen) return
    const close = (e) => {
      if (weightInfoRef.current && !weightInfoRef.current.contains(e.target)) {
        setWeightInfoOpen(false)
      }
    }
    document.addEventListener('click', close)
    return () => document.removeEventListener('click', close)
  }, [weightInfoOpen])

  useEffect(() => {
    if (!weightInfoHover && !weightInfoOpen) return
    const el = weightInfoRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    setTooltipPos({
      top: rect.bottom + 8,
      left: rect.left + rect.width / 2
    })
  }, [weightInfoHover, weightInfoOpen])

  const aggregatedProducts = aggregateByProduct(blocks)
  const totalRows = aggregatedProducts.length
  const totalPages = Math.ceil(totalRows / ROWS_PER_PAGE) || 1
  const start = (page - 1) * ROWS_PER_PAGE
  const visibleProducts = aggregatedProducts.slice(start, start + ROWS_PER_PAGE)
  const hasAnySales = aggregatedProducts.some((p) => p.totalQty > 0 || p.amountTotal > 0)
  const hasRowsButNoSales = aggregatedProducts.length > 0 && !hasAnySales

  const hasDateRangeFilter = Boolean(dateFrom || dateTo)
  const hasValidDateRange = Boolean(
    dateFrom &&
      dateTo &&
      /^\d{4}-\d{2}-\d{2}$/.test(dateFrom) &&
      /^\d{4}-\d{2}-\d{2}$/.test(dateTo)
  )
  const noDateFilter = !dateFrom && !dateTo
  /** Период для БД: месяц по «От» при полном диапазоне; иначе all/all для «за всё время» */
  const periodTypeParam = hasValidDateRange ? 'month' : (noDateFilter ? 'all' : null)
  const periodValueParam = hasValidDateRange ? dateFrom.slice(0, 7) : (noDateFilter ? 'all' : null)
  const showManualBalanceColumns = periodTypeParam != null && periodValueParam != null
  const isAllTime = noDateFilter
  const reportDateLabel = hasDateRangeFilter
    ? `${formatDateDisplay(dateFrom)} - ${formatDateDisplay(dateTo)}`
    : 'За все время'
  const reportWeekday = null
  const currentPointName = user?.pointName || (isAdmin ? 'Червенский' : '')

  const openingBalanceKey = (p) => reportBalanceStorageKey(p.subcategoryId, p.productName, p.price)

  const handleOpeningBalanceBlur = useCallback(async (p, value) => {
    const key = openingBalanceKey(p)
    const prevVal = openingBalances[key]
    const trimmed = String(value ?? '').trim()
    setOpeningBalances((prev) => {
      const next = { ...prev }
      if (trimmed === '') delete next[key]
      else next[key] = trimmed
      return next
    })
    try {
      await reportTableService.updateOpeningBalance(
        periodTypeParam,
        periodValueParam,
        p.subcategoryId,
        p.productName,
        p.price,
        trimmed
      )
    } catch (e) {
      const revert = () =>
        setOpeningBalances((prev) => {
          const next = { ...prev }
          if (prevVal === undefined || prevVal === null || prevVal === '') delete next[key]
          else next[key] = prevVal
          return next
        })
      if (e?.message === 'UNAUTHORIZED') {
        const ok = await refreshAccessToken()
        if (ok) {
          try {
            await reportTableService.updateOpeningBalance(
              periodTypeParam,
              periodValueParam,
              p.subcategoryId,
              p.productName,
              p.price,
              trimmed
            )
          } catch (retryErr) {
            revert()
            setOpeningBalanceSaveError(
              retryErr?.status === 404
                ? 'Не удалось сохранить входящий остаток (404). Перезапустите бэкенд и обновите страницу.'
                : (retryErr?.message || 'Ошибка сохранения')
            )
          }
        } else {
          revert()
        }
      } else {
        revert()
        setOpeningBalanceSaveError(
          e?.status === 404
            ? 'Не удалось сохранить входящий остаток (404). Перезапустите бэкенд и обновите страницу.'
            : (e?.message || 'Ошибка сохранения')
        )
      }
    }
  }, [periodTypeParam, periodValueParam, refreshAccessToken, openingBalances])

  const handleClosingBalanceBlur = useCallback(async (p, value) => {
    const key = openingBalanceKey(p)
    const prevQuantity = closingBalances[key] ?? 0
    const num = parseInt(String(value).replace(/\s/g, ''), 10)
    const quantity = Number.isNaN(num) ? 0 : Math.max(0, num)
    setClosingBalances((prev) => ({ ...prev, [key]: quantity }))
    try {
      await reportTableService.updateClosingBalance(
        periodTypeParam,
        periodValueParam,
        p.subcategoryId,
        p.productName,
        p.price,
        quantity
      )
    } catch (e) {
      const revert = () => setClosingBalances((prev) => ({ ...prev, [key]: prevQuantity }))
      if (e?.message === 'UNAUTHORIZED') {
        const ok = await refreshAccessToken()
        if (ok) {
          try {
            await reportTableService.updateClosingBalance(
              periodTypeParam,
              periodValueParam,
              p.subcategoryId,
              p.productName,
              p.price,
              quantity
            )
          } catch (retryErr) {
            revert()
            setClosingBalanceSaveError(
              retryErr?.status === 404
                ? 'Не удалось сохранить остаток на конец дня (404). Перезапустите бэкенд и обновите страницу.'
                : (retryErr?.message || 'Ошибка сохранения')
            )
          }
        } else {
          revert()
        }
      } else {
        revert()
        setClosingBalanceSaveError(
          e?.status === 404
            ? 'Не удалось сохранить остаток на конец дня (404). Перезапустите бэкенд и обновите страницу.'
            : (e?.message || 'Ошибка сохранения')
        )
      }
    }
  }, [periodTypeParam, periodValueParam, refreshAccessToken, closingBalances])

  useEffect(() => {
    if (editingOpeningBalanceKey != null && openingBalanceCellRef.current) {
      const val = openingBalances[editingOpeningBalanceKey]
      openingBalanceCellRef.current.textContent =
        val === '' || val === undefined || val === null ? '' : String(val)
    }
  }, [editingOpeningBalanceKey])

  useEffect(() => {
    if (editingClosingBalanceKey != null && closingBalanceCellRef.current) {
      const val = closingBalances[editingClosingBalanceKey]
      closingBalanceCellRef.current.textContent = val === '' || val === undefined ? '' : String(val)
    }
  }, [editingClosingBalanceKey])

  const totals = aggregatedProducts.length > 0
    ? aggregatedProducts.reduce(
        (acc, p) => ({
          totalQty: acc.totalQty + p.totalQty,
          qtyCash: acc.qtyCash + p.qtyCash,
          qtyCard: acc.qtyCard + p.qtyCard,
          qtyMixed: acc.qtyMixed + p.qtyMixed,
          amountCash: acc.amountCash + p.amountCash,
          amountCard: acc.amountCard + p.amountCard,
          amountTotal: acc.amountTotal + p.amountTotal
        }),
        { totalQty: 0, qtyCash: 0, qtyCard: 0, qtyMixed: 0, amountCash: 0, amountCard: 0, amountTotal: 0 }
      )
    : null

  const handleExportExcel = useCallback(async () => {
    const rows = buildReportTableRows({
      products: aggregatedProducts,
      openingBalances,
      closingBalances,
      totals: totals ?? null,
      openingBalanceKey,
      isAllTime: !showManualBalanceColumns
    })
    let filename = 'Таблица отчёта'
    if (hasDateRangeFilter) filename += ` ${dateFrom || '...'}_${dateTo || '...'}`
    else filename += ' все время'
    await downloadReportTableExcel(rows, filename)
  }, [aggregatedProducts, openingBalances, closingBalances, totals, hasDateRangeFilter, dateFrom, dateTo, showManualBalanceColumns])

  return (
    <div className="report-table-page">
      <div className="report-table-header">
        <h2>Таблица отчёта</h2>
        <div className="report-table-filters">
          <div className="report-table-date-row">
            <label htmlFor="report-table-date-from" className="report-table-date-label">От:</label>
            <input
              id="report-table-date-from"
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="report-table-date-input"
            />
          </div>
          <div className="report-table-date-row">
            <label htmlFor="report-table-date-to" className="report-table-date-label">До:</label>
            <input
              id="report-table-date-to"
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="report-table-date-input"
            />
          </div>
          <div className="report-table-date-row">
            <button
              type="button"
              className="report-table-import-btn"
              onClick={() => {
                setDateFrom('')
                setDateTo('')
              }}
              disabled={!dateFrom && !dateTo}
            >
              Очистить
            </button>
          </div>
          {currentPointName && (
            <div className="report-table-date-row">
              <span className="report-table-date-label">Точка: {currentPointName}</span>
            </div>
          )}
          {!loading && !error && aggregatedProducts.length > 0 && (
            <div className="report-table-date-row">
              <button
                type="button"
                className="report-table-import-btn report-table-export-btn"
                onClick={handleExportExcel}
              >
                Экспорт в Excel
              </button>
            </div>
          )}
        </div>
      </div>
      {error && <div className="report-table-error">{error}</div>}
      {openingBalanceSaveError && (
        <div className="report-table-error report-table-save-error">
          {openingBalanceSaveError}
        </div>
      )}
      {closingBalanceSaveError && (
        <div className="report-table-error report-table-save-error">
          {closingBalanceSaveError}
        </div>
      )}
      {loading && <div className="report-table-loading">Загрузка...</div>}
      {!loading && !error && blocks.length === 0 && (
        <div className="report-table-empty">
          Нет подкатегорий с включённой галочкой «Учёт в таблице отчёта». Включите её у подкатегорий в разделе «Категории и товары».
        </div>
      )}
      {!loading && !error && hasRowsButNoSales && (
        <div className="report-table-empty">
          {hasDateRangeFilter ? 'За выбранный период нет продаж.' : 'За все время нет продаж.'}
        </div>
      )}
      {!loading && !error && aggregatedProducts.length > 0 && (
        <>
          <div className="report-table-excel-wrap">
            <div className="report-table-excel-sheet">
              <div className="report-table-excel-title-row">
                <span className="report-table-excel-title">Отчетный бланк</span>
                <span className="report-table-excel-meta">
                  Дата: <strong>{reportDateLabel}</strong>
                  {reportWeekday != null && (
                    <>
                      {' \u00A0\u00A0 '}
                      День недели: <strong>{reportWeekday}</strong>
                    </>
                  )}
                  {currentPointName && (
                    <>
                      {' \u00A0\u00A0 '}
                      Точка: <strong>{currentPointName}</strong>
                    </>
                  )}
                </span>
              </div>
              <div className="report-table-excel-table-wrap">
                <table className="report-table-excel report-table-excel-full">
                  <thead>
                    <tr>
                      <th className="report-table-excel-th-weight">
                        <span className="report-table-excel-th-weight-label">Вес</span>
                        <span
                          ref={weightInfoRef}
                          className="report-table-weight-info-wrap"
                        >
                          <button
                            type="button"
                            className="report-table-weight-info-btn"
                            aria-label="Подсказка о колонке Вес"
                            onClick={(e) => {
                              e.stopPropagation()
                              setWeightInfoOpen((v) => !v)
                            }}
                            onMouseEnter={() => setWeightInfoHover(true)}
                            onMouseLeave={() => setWeightInfoHover(false)}
                          >
                            i
                          </button>
                          {(weightInfoHover || weightInfoOpen) &&
                            createPortal(
                              <span
                                className="report-table-weight-info-tooltip report-table-weight-info-tooltip-portal"
                                role="tooltip"
                                style={{
                                  position: 'fixed',
                                  top: tooltipPos.top,
                                  left: tooltipPos.left,
                                  transform: 'translateX(-50%)'
                                }}
                              >
                                {WEIGHT_COLUMN_TOOLTIP}
                              </span>,
                              document.body
                            )}
                        </span>
                      </th>
                      <th className="report-table-excel-th-name">Наименование:</th>
                      <th className="report-table-excel-th-num">Входящий остаток, шт.</th>
                      <th className="report-table-excel-th-num">Цена за ед., руб.</th>
                      <th colSpan={4} className="report-table-excel-th-merged">
                        Продано (зерна/молотый, руб.)
                      </th>
                      <th className="report-table-excel-th-num">Итого продано, шт.</th>
                      <th className="report-table-excel-th-num">НАЛИЧ, руб</th>
                      <th className="report-table-excel-th-num">БЕЗНАЛ, руб</th>
                      <th className="report-table-excel-th-num">ИТОГО, руб.</th>
                      <th className="report-table-excel-th-num">Остаток на конец дня, шт.</th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleProducts.map((p, idx) => (
                      <tr key={`${start}-${p.productName}-${p.price}`}>
                        <td className="report-table-excel-td-weight">{p.subcategoryName}</td>
                        <td className="report-table-excel-td-name">{p.productName}</td>
                        {showManualBalanceColumns ? (
                          <td
                            ref={editingOpeningBalanceKey === openingBalanceKey(p) ? openingBalanceCellRef : undefined}
                            className="report-table-excel-num report-table-excel-td-num report-table-excel-td-editable"
                            contentEditable={true}
                            suppressContentEditableWarning
                            role="textbox"
                            inputMode="text"
                            aria-label={`Входящий остаток: ${p.productName}`}
                            onKeyDown={reportOpeningBalanceKeyDown}
                            onFocus={() => setEditingOpeningBalanceKey(openingBalanceKey(p))}
                            onBlur={(e) => {
                              const raw = (e.currentTarget.textContent || '').trim()
                              handleOpeningBalanceBlur(p, raw)
                              setEditingOpeningBalanceKey(null)
                            }}
                          >
                            {editingOpeningBalanceKey === openingBalanceKey(p) ? null : (openingBalances[openingBalanceKey(p)] ?? '')}
                          </td>
                        ) : (
                          <td className="report-table-excel-num report-table-excel-td-num" />
                        )}
                        <td className="report-table-excel-num report-table-excel-td-num">{p.price.toFixed(2)}</td>
                        <td className="report-table-excel-num report-table-excel-td-num">{formatInt(p.qtyCash)}</td>
                        <td className="report-table-excel-num report-table-excel-td-num">{formatInt(p.qtyCard)}</td>
                        <td className="report-table-excel-num report-table-excel-td-num">{formatInt(p.qtyMixed)}</td>
                        <td className="report-table-excel-num report-table-excel-td-num">{formatInt(p.totalQty)}</td>
                        <td className="report-table-excel-num report-table-excel-td-num">{formatInt(p.totalQty)}</td>
                        <td className="report-table-excel-num report-table-excel-td-num">{formatNum(p.amountCash)}</td>
                        <td className="report-table-excel-num report-table-excel-td-num">{formatNum(p.amountCard)}</td>
                        <td className="report-table-excel-num report-table-excel-td-num">{formatNum(p.amountTotal)}</td>
                        {showManualBalanceColumns ? (
                          <td
                            ref={editingClosingBalanceKey === openingBalanceKey(p) ? closingBalanceCellRef : undefined}
                            className="report-table-excel-num report-table-excel-td-num report-table-excel-td-editable"
                            contentEditable={true}
                            suppressContentEditableWarning
                            role="textbox"
                            inputMode="numeric"
                            aria-label={`Остаток на конец дня: ${p.productName}`}
                            onKeyDown={reportBalanceDigitsKeyDown}
                            onBeforeInput={reportBalanceDigitsBeforeInput}
                            onPaste={reportBalanceDigitsPaste}
                            onCompositionEnd={reportBalanceDigitsCompositionEnd}
                            onFocus={() => setEditingClosingBalanceKey(openingBalanceKey(p))}
                            onBlur={(e) => {
                              const raw = (e.currentTarget.textContent || '').replace(/\D/g, '')
                              handleClosingBalanceBlur(p, raw)
                              setEditingClosingBalanceKey(null)
                            }}
                          >
                            {editingClosingBalanceKey === openingBalanceKey(p) ? null : (closingBalances[openingBalanceKey(p)] ?? '')}
                          </td>
                        ) : (
                          <td className="report-table-excel-num report-table-excel-td-num" />
                        )}
                      </tr>
                    ))}
                  </tbody>
                  {totals != null && (
                    <tfoot>
                      <tr className="report-table-excel-total-row">
                        <td className="report-table-excel-td-weight" />
                        <td className="report-table-excel-td-name">ИТОГО</td>
                        <td className="report-table-excel-num report-table-excel-td-num" />
                        <td className="report-table-excel-num report-table-excel-td-num" />
                        <td className="report-table-excel-num report-table-excel-td-num report-table-excel-td-total-group">{totals.qtyCash}</td>
                        <td className="report-table-excel-num report-table-excel-td-num report-table-excel-td-total-group">{totals.qtyCard}</td>
                        <td className="report-table-excel-num report-table-excel-td-num report-table-excel-td-total-group">{totals.qtyMixed}</td>
                        <td className="report-table-excel-num report-table-excel-td-num report-table-excel-td-total-group">{totals.totalQty}</td>
                        <td className="report-table-excel-num report-table-excel-td-num">{totals.totalQty}</td>
                        <td className="report-table-excel-num report-table-excel-td-num">{totals.amountCash.toFixed(2)}</td>
                        <td className="report-table-excel-num report-table-excel-td-num">{totals.amountCard.toFixed(2)}</td>
                        <td className="report-table-excel-num report-table-excel-td-num">{totals.amountTotal.toFixed(2)}</td>
                        <td className="report-table-excel-num report-table-excel-td-num" />
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>
          </div>
          {totalPages > 1 && (
            <div className="report-table-pagination">
              <button
                type="button"
                onClick={() => setPage((p) => Math.max(1, p - 1))}
                disabled={page === 1}
                className="report-table-pagination-btn"
              >
                Назад
              </button>
              <span className="report-table-pagination-info">
                Строки {start + 1}–{Math.min(start + ROWS_PER_PAGE, totalRows)} из {totalRows}
              </span>
              <button
                type="button"
                onClick={() => setPage((p) => Math.min(totalPages, p + 1))}
                disabled={page === totalPages}
                className="report-table-pagination-btn"
              >
                Вперёд
              </button>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export default ReportTablePage
