import React from 'react'
import './ClientCard.css'
import { formatMinskDate } from '../utils/dateTime'
import { normalizeMiddleNameForDisplay, normalizeClientIdForDisplay } from '../utils/clientDisplay'

const ClientCard = ({ client }) => {
  const fullName = [
    client.first_name,
    client.last_name,
    normalizeMiddleNameForDisplay(client.middle_name)
  ]
    .filter(Boolean)
    .join(' ')

  const createdDate = formatMinskDate(client.created_at)

  const clientDiscountPercent = Number(client.discount_percent) || 0
  const effectiveDiscount = clientDiscountPercent > 0 ? clientDiscountPercent : (client.status === 'gold' ? 10 : 0)

  return (
    <div className={`client-card ${client.status}`}>
      <div className="client-header">
        <div className="client-name">{fullName}</div>
        <span className={`status-badge ${client.status}`}>
          {client.status.toUpperCase()}
        </span>
      </div>
      <div className="client-info">
        <div className="client-info-row">
          <span className="info-label">ID клиента:</span>
          <span className="info-value">{normalizeClientIdForDisplay(client.client_id)}</span>
        </div>
        <div className="client-info-row">
          <span className="info-label">Дата регистрации:</span>
          <span className="info-value">{createdDate}</span>
        </div>
      </div>
      <div className="total-spent">
        <span className="total-spent-label">Сумма покупок</span>
        <span className="total-spent-value">
          {parseFloat(client.total_spent || 0).toFixed(2)} BYN
        </span>
        <span className="total-spent-label" style={{ marginTop: 8 }}>Зачислено на счёт</span>
        <span className="total-spent-value">
          {parseFloat(client.account_balance ?? 0).toFixed(2)} BYN
        </span>
        {effectiveDiscount > 0 && (
          <div className="discount-active">🎉 Скидка {effectiveDiscount}% активна</div>
        )}
      </div>
    </div>
  )
}

export default ClientCard
