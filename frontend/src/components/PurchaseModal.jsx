import React, { useEffect, useMemo, useState } from 'react'
import { useClients } from '../hooks/useClients'
import { useNotification } from './NotificationProvider'
import { useDataRefresh } from '../contexts/DataRefreshContext'
import ProductSelector from './ProductSelector'
import PaymentMethodModal from './PaymentMethodModal'
import { normalizeMiddleNameForDisplay, normalizeClientIdForDisplay } from '../utils/clientDisplay'
import './PurchaseModal.css'

const MODE_ORDER = 'order'
const MODE_TOPUP = 'topup'

const PurchaseModal = ({ client, onClose }) => {
  const [liveClient, setLiveClient] = useState(client)
  const [mode, setMode] = useState(MODE_ORDER)
  const [price, setPrice] = useState('')
  const [loading, setLoading] = useState(false)
  const [selectedProducts, setSelectedProducts] = useState({})
  const [productsTotal, setProductsTotal] = useState(0)
  const [showPaymentModal, setShowPaymentModal] = useState(false)
  const [pendingPurchaseData, setPendingPurchaseData] = useState(null)
  const { addPurchase } = useClients()
  const { showNotification } = useNotification()
  const { refreshAll } = useDataRefresh()

  useEffect(() => {
    setLiveClient(client)
  }, [client])
  
  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [onClose])

  const fullName = useMemo(() => {
    return [liveClient?.first_name, liveClient?.last_name, normalizeMiddleNameForDisplay(liveClient?.middle_name)].filter(Boolean).join(' ')
  }, [liveClient])

  const purchaseTotal = useMemo(() => {
    const v = Number.parseFloat(liveClient?.total_spent || 0)
    return Number.isFinite(v) ? v : 0
  }, [liveClient])

  const accountBalance = useMemo(() => {
    const v = Number.parseFloat(liveClient?.account_balance ?? 0)
    return Number.isFinite(v) ? v : 0
  }, [liveClient])

  const discountInfo = useMemo(() => {
    const p = productsTotal > 0 ? productsTotal : Number.parseFloat(price)
    if (!Number.isFinite(p) || p <= 0) return null
    const status = liveClient?.status || 'standart'
    const personalPercent = Number(liveClient?.discount_percent) || 0
    const discount = personalPercent > 0 ? personalPercent : (status === 'gold' ? 10 : 0)
    if (discount > 0) {
      const finalPrice = p * (1 - discount / 100)
      const savedAmount = p - finalPrice
      return {
        originalPrice: p,
        finalPrice,
        discount,
        savedAmount
      }
    }
    return null
  }, [price, productsTotal, liveClient?.status, liveClient?.discount_percent])

  const handleProductsChange = (cart, total) => {
    setSelectedProducts(cart)
    setProductsTotal(total)
    // Автоматически обновляем цену в форме, если есть товары
    if (total > 0) {
      setPrice(total.toFixed(2))
    }
  }

  const createPurchaseWithPayment = async (paymentMethod, options, purchaseDataOverride = null) => {
    setLoading(true)
    setShowPaymentModal(false)

    try {
      const purchaseData = purchaseDataOverride ?? pendingPurchaseData
      if (!purchaseData) {
        setLoading(false)
        return
      }

      const mixedParts = paymentMethod === 'mixed' && options ? { cashPart: options.cashPart, cardPart: options.cardPart } : null
      const result = await addPurchase(liveClient.id, purchaseData.price, purchaseData.items, paymentMethod, 0, mixedParts, purchaseData.isTopUp)
      if (result.success) {
        const updatedClient = result?.result?.client
        if (updatedClient && purchaseData.isTopUp) {
          setLiveClient((prev) => ({ ...prev, ...updatedClient }))
        }
        showNotification(purchaseData.isTopUp ? 'Средства зачислены на счёт!' : 'Покупка успешно добавлена!', 'success')
        setTimeout(() => refreshAll(), 100)
        onClose()
        setPrice('')
        setSelectedProducts({})
        setProductsTotal(0)
        setPendingPurchaseData(null)
      } else {
        showNotification(result.error, 'error')
      }
    } catch (error) {
      showNotification(error.message || 'Ошибка при обработке запроса', 'error')
    }

    setLoading(false)
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    const isTopUp = mode === MODE_TOPUP
    const p = isTopUp ? Number.parseFloat(price) : (productsTotal > 0 ? productsTotal : Number.parseFloat(price))
    if (!Number.isFinite(p) || p <= 0) {
      showNotification(isTopUp ? 'Введите сумму для зачисления' : 'Введите корректную цену или выберите товары', 'error')
      return
    }

    const finalAmount = isTopUp ? p : (discountInfo ? discountInfo.finalPrice : p)
    const items = isTopUp ? [] : Object.values(selectedProducts).map(item => ({
      productId: item.product.id,
      productName: item.product.name,
      productPrice: item.product.price,
      quantity: item.quantity
    }))
    const purchaseData = { price: p, items, finalAmount, isTopUp }
    setPendingPurchaseData(purchaseData)
    if (isTopUp) {
      createPurchaseWithPayment('cash', null, purchaseData)
      return
    }
    setShowPaymentModal(true)
  }

  const handleOverlayClick = (e) => {
    if (e.target === e.currentTarget) onClose()
  }

  if (!liveClient) return null

  return (
    <div className="modal" onClick={handleOverlayClick}>
      <div className="modal-overlay"></div>
      <div className="modal-content modal-content-large">
        <div className="modal-header">
          <div>
            <h2>
              {mode === MODE_TOPUP ? 'Зачислить на счёт' : 'Новая покупка'}
            </h2>
            <div className="purchase-subtitle">
              Клиент: <span className="mono">{fullName || '—'}</span> • ID:{' '}
              <span className="mono">{normalizeClientIdForDisplay(liveClient.client_id)}</span>
            </div>
            <div className="purchase-modal-tabs">
              <button
                type="button"
                className={`purchase-modal-tab ${mode === MODE_ORDER ? 'active' : ''}`}
                onClick={() => setMode(MODE_ORDER)}
              >
                Оформить заказ
              </button>
              <button
                type="button"
                className={`purchase-modal-tab ${mode === MODE_TOPUP ? 'active' : ''}`}
                onClick={() => setMode(MODE_TOPUP)}
              >
                Зачислить на счёт
              </button>
            </div>
          </div>
          <button className="close-modal" onClick={onClose}>
            &times;
          </button>
        </div>

        <div className="purchase-summary">
          <div>
            Счёт клиента: <span className="mono">{accountBalance.toFixed(2)} BYN</span>
          </div>
          <div>
            Статус: <span className={`status-chip ${liveClient.status}`}>{liveClient.status?.toUpperCase()}</span>
          </div>
        </div>

        <div className="modal-two-columns">
          {/* Левая колонка - Выбор товаров (только в режиме заказа) */}
          {mode === MODE_ORDER && (
            <div className="modal-left-column">
              <h3 style={{ marginBottom: 14, fontSize: '1rem', fontWeight: 600, color: 'var(--text)' }}>
                Выбор товаров
              </h3>
              <ProductSelector 
                onProductsChange={handleProductsChange}
                initialTotal={productsTotal}
              />
            </div>
          )}

          {/* Правая колонка - Форма заказа / зачисление */}
          {(mode === MODE_ORDER || mode === MODE_TOPUP) && (
          <div className={`modal-right-column ${mode === MODE_TOPUP ? 'modal-right-column-full' : ''}`}>
            <form onSubmit={handleSubmit}>
              <div className="form-row one-col">
                <div className="input-group">
                  <label>{mode === MODE_TOPUP ? 'Сумма к зачислению (BYN)' : 'Цена'}</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    value={price}
                    onChange={(e) => setPrice(e.target.value)}
                    disabled={loading}
                    autoFocus
                    placeholder={mode === MODE_TOPUP ? '0.00' : undefined}
                  />
                </div>
              </div>

              {mode === MODE_ORDER && discountInfo && (
                <div className="discount-preview">
                  <div className="discount-badge">
                    <span>Скидка {discountInfo.discount}%</span>
                  </div>
                  <div className="price-preview">
                    <div className="price-original">
                      {discountInfo.originalPrice.toFixed(2)} BYN
                    </div>
                    <div className="price-final">
                      {discountInfo.finalPrice.toFixed(2)} BYN
                    </div>
                    <div className="price-saved">
                      Экономия: {discountInfo.savedAmount.toFixed(2)} BYN
                    </div>
                  </div>
                </div>
              )}

              <div className="modal-actions">
                <button type="button" className="btn-cancel" onClick={onClose} disabled={loading}>
                  Отмена
                </button>
                <button type="submit" className="btn-submit" disabled={loading}>
                  {loading ? 'Сохранение...' : mode === MODE_TOPUP ? 'Зачислить' : 'Добавить покупку'}
                </button>
              </div>
            </form>
          </div>
          )}
        </div>
      </div>

      {showPaymentModal && pendingPurchaseData && (
        <PaymentMethodModal
          totalAmount={pendingPurchaseData.finalAmount ?? pendingPurchaseData.price}
          onSelect={createPurchaseWithPayment}
          onClose={() => {
            setShowPaymentModal(false)
            setPendingPurchaseData(null)
          }}
        />
      )}
    </div>
  )
}

export default PurchaseModal

