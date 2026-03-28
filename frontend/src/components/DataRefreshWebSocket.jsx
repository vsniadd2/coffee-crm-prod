import React, { useEffect, useRef } from 'react'
import { useDataRefresh } from '../contexts/DataRefreshContext'
import { getWsUrl } from '../config/api'

const INITIAL_CONNECT_DELAY_MS = 800
const RECONNECT_MIN_MS = 3000
const RECONNECT_MAX_MS = 20000

/**
 * Подключается к WebSocket серверу и при получении data_updated
 * вызывает refreshAll — данные обновляются без опроса по таймеру.
 */
const DataRefreshWebSocket = () => {
  const { refreshAll } = useDataRefresh()
  const wsRef = useRef(null)
  const reconnectTimeoutRef = useRef(null)
  const reconnectDelayRef = useRef(RECONNECT_MIN_MS)
  const unmountedRef = useRef(false)

  useEffect(() => {
    const url = getWsUrl()
    if (!url) return

    unmountedRef.current = false

    const connect = () => {
      if (unmountedRef.current) return
      try {
        const ws = new WebSocket(url)
        wsRef.current = ws

        ws.onmessage = (event) => {
          try {
            const data = JSON.parse(event.data)
            if (data?.type === 'data_updated') {
              refreshAll({ silent: true })
            }
          } catch {
            // ignore
          }
        }

        ws.onclose = () => {
          wsRef.current = null
          if (unmountedRef.current) return
          reconnectTimeoutRef.current = setTimeout(connect, reconnectDelayRef.current)
          reconnectDelayRef.current = Math.min(reconnectDelayRef.current + 2000, RECONNECT_MAX_MS)
        }

        ws.onopen = () => {
          reconnectDelayRef.current = RECONNECT_MIN_MS
        }

        ws.onerror = () => {}
      } catch {
        if (unmountedRef.current) return
        reconnectTimeoutRef.current = setTimeout(connect, reconnectDelayRef.current)
      }
    }

    const t = setTimeout(connect, INITIAL_CONNECT_DELAY_MS)

    return () => {
      unmountedRef.current = true
      clearTimeout(t)
      if (reconnectTimeoutRef.current) {
        clearTimeout(reconnectTimeoutRef.current)
        reconnectTimeoutRef.current = null
      }
      if (wsRef.current) {
        try {
          wsRef.current.close()
        } catch {
          // ignore
        }
        wsRef.current = null
      }
    }
  }, [refreshAll])

  return null
}

export default DataRefreshWebSocket
