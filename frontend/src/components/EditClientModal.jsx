import React, { useState, useEffect } from 'react'
import { clientService } from '../services/clientService'
import { useNotification } from './NotificationProvider'
import { useDataRefresh } from '../contexts/DataRefreshContext'
import { useAuth } from '../contexts/AuthContext'
import ConfirmDialog from './ConfirmDialog'
import { normalizeMiddleNameForDisplay } from '../utils/clientDisplay'
import './ClientModal.css'
import './EditClientModal.css'

const EditClientModal = ({ client, onClose }) => {
  const [formData, setFormData] = useState({
    firstName: '',
    lastName: '',
    middleName: '',
    clientId: '',
    status: 'standart',
    discountPercent: ''
  })
  const [loading, setLoading] = useState(false)
  const [fetchClientLoading, setFetchClientLoading] = useState(true)
  const [confirmDelete, setConfirmDelete] = useState(false)

  const { showNotification } = useNotification()
  const { refreshAll } = useDataRefresh()
  const { refreshAccessToken, user } = useAuth()
  const isAdmin = user?.role === 'admin'

  // При открытии модалки всегда подгружаем клиента из API, чтобы видеть актуальные данные из БД (в т.ч. discount_percent)
  useEffect(() => {
    if (!client?.id) {
      setFetchClientLoading(false)
      return
    }
    let cancelled = false
    setFetchClientLoading(true)
    clientService.getByIdDb(client.id)
      .then((data) => {
        if (cancelled || !data) return
        const dp = data.discount_percent
        setFormData({
          firstName: data.first_name || '',
          lastName: data.last_name || '',
          middleName: normalizeMiddleNameForDisplay(data.middle_name) || '',
          clientId: data.client_id || '',
          status: data.status || 'standart',
          discountPercent: dp != null && dp !== '' ? String(dp) : ''
        })
      })
      .catch(() => { if (!cancelled) setFormData(prev => prev) })
      .finally(() => { if (!cancelled) setFetchClientLoading(false) })
    return () => { cancelled = true }
  }, [client?.id])

  useEffect(() => {
    const handleEscape = (e) => {
      if (e.key === 'Escape' && !confirmDelete) onClose()
    }
    document.addEventListener('keydown', handleEscape)
    return () => document.removeEventListener('keydown', handleEscape)
  }, [onClose, confirmDelete])

  const handleChange = (e) => {
    const { name, value } = e.target
    setFormData(prev => ({ ...prev, [name]: value }))
  }

  const handleSubmit = async (e) => {
    e.preventDefault()
    setLoading(true)
    const payload = {
      firstName: formData.firstName,
      lastName: formData.lastName,
      middleName: formData.middleName,
      clientId: formData.clientId,
      status: formData.status,
      discountPercent: formData.discountPercent === '' ? 0 : (Number(formData.discountPercent) || 0)
    }
    try {
      await clientService.update(client.id, payload)
      showNotification('Данные клиента сохранены', 'success')
      refreshAll()
      onClose()
    } catch (err) {
      if (err?.message === 'UNAUTHORIZED') {
        const refreshed = await refreshAccessToken()
        if (refreshed) {
          try {
            await clientService.update(client.id, payload)
            showNotification('Данные клиента сохранены', 'success')
            refreshAll()
            onClose()
            return
          } catch (retryErr) {
            showNotification(retryErr.message || 'Ошибка сохранения', 'error')
          }
        } else {
          showNotification('Сессия истекла. Войдите снова.', 'error')
        }
      } else {
        showNotification(err.message || 'Ошибка сохранения', 'error')
      }
    } finally {
      setLoading(false)
    }
  }

  const handleDeleteClick = () => {
    setConfirmDelete(true)
  }

  const handleConfirmDelete = async () => {
    setLoading(true)
    try {
      await clientService.delete(client.id)
      showNotification('Клиент удалён', 'success')
      refreshAll()
      setConfirmDelete(false)
      onClose()
    } catch (err) {
      if (err?.message === 'UNAUTHORIZED') {
        const refreshed = await refreshAccessToken()
        if (refreshed) {
          try {
            await clientService.delete(client.id)
            showNotification('Клиент удалён', 'success')
            refreshAll()
            setConfirmDelete(false)
            onClose()
            return
          } catch (retryErr) {
            showNotification(retryErr.message || 'Ошибка удаления', 'error')
          }
        } else {
          showNotification('Сессия истекла. Войдите снова.', 'error')
        }
      } else {
        showNotification(err.message || 'Ошибка удаления', 'error')
      }
    } finally {
      setLoading(false)
    }
  }

  if (!client) return null

  return (
    <>
      <div className="edit-client-modal modal" role="dialog" aria-modal="true">
        <div className="modal-overlay" onClick={onClose} />
        <div className="modal-content edit-client-modal-content" onClick={e => e.stopPropagation()}>
          <div className="modal-header">
            <h2>Редактирование клиента</h2>
            <button type="button" className="close-modal" onClick={onClose} aria-label="Закрыть">
              ×
            </button>
          </div>
          <form onSubmit={handleSubmit}>
            {fetchClientLoading && (
              <div style={{ padding: '12px 0', color: 'var(--muted)', fontSize: '0.9rem' }}>Загрузка данных клиента...</div>
            )}
            <div className="form-row">
              <div className="input-group">
                <label>Имя</label>
                <input
                  type="text"
                  name="firstName"
                  value={formData.firstName}
                  onChange={handleChange}
                  disabled={loading || fetchClientLoading}
                />
              </div>
              <div className="input-group">
                <label>Фамилия</label>
                <input
                  type="text"
                  name="lastName"
                  value={formData.lastName}
                  onChange={handleChange}
                  disabled={loading || fetchClientLoading}
                />
              </div>
            </div>
            <div className="form-row">
              <div className="input-group">
                <label>Отчество</label>
                <input
                  type="text"
                  name="middleName"
                  value={formData.middleName}
                  onChange={handleChange}
                  disabled={loading || fetchClientLoading}
                />
              </div>
              <div className="input-group">
                <label>ID (телефон или строка)</label>
                <input
                  type="text"
                  name="clientId"
                  value={formData.clientId}
                  onChange={handleChange}
                  disabled={loading || fetchClientLoading}
                />
              </div>
            </div>
            <div className="form-row">
              <div className="input-group">
                <label>Статус</label>
                <select
                  name="status"
                  value={formData.status}
                  onChange={handleChange}
                  disabled={loading || fetchClientLoading}
                  className="edit-client-status-select"
                >
                  <option value="standart">STANDART</option>
                  <option value="gold">GOLD</option>
                </select>
              </div>
              <div className="input-group">
                <label>Процент скидки (%)</label>
                <input
                  type="number"
                  name="discountPercent"
                  min={0}
                  max={100}
                  step={1}
                  value={formData.discountPercent}
                  onChange={handleChange}
                  disabled={loading || fetchClientLoading}
                  placeholder="0"
                />
              </div>
            </div>
            <div className="edit-client-actions">
              <button type="submit" className="btn-submit" disabled={loading || fetchClientLoading}>
                {loading ? 'Сохранение...' : 'Сохранить'}
              </button>
              {isAdmin && (
                <button
                  type="button"
                  className="btn-delete-client"
                  onClick={handleDeleteClick}
                  disabled={loading || fetchClientLoading}
                >
                  Удалить клиента
                </button>
              )}
            </div>
          </form>
        </div>
      </div>
      {confirmDelete && (
        <ConfirmDialog
          isOpen={confirmDelete}
          title="Удалить клиента?"
          message="Все данные и история покупок этого клиента будут удалены. Это действие нельзя отменить."
          confirmText="Удалить"
          cancelText="Отмена"
          confirmType="danger"
          onConfirm={handleConfirmDelete}
          onCancel={() => setConfirmDelete(false)}
        />
      )}
    </>
  )
}

export default EditClientModal
