import React, { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react'

const DataRefreshContext = createContext()

export const useDataRefresh = () => {
  const context = useContext(DataRefreshContext)
  if (!context) {
    throw new Error('useDataRefresh must be used within DataRefreshProvider')
  }
  return context
}

export const DataRefreshProvider = ({ children }) => {
  const [refreshKey, setRefreshKey] = useState(0)
  const refreshCallbacksRef = useRef(new Set())
  const autoRefreshIntervalRef = useRef(null)
  const [autoRefreshEnabled, setAutoRefreshEnabled] = useState(true)
  const lastRefreshTimeRef = useRef(Date.now())
  const pendingRefreshRef = useRef(false)
  const lastVisibilityRefreshRef = useRef(0)

  const registerRefreshCallback = useCallback((callback) => {
    refreshCallbacksRef.current.add(callback)
    return () => {
      refreshCallbacksRef.current.delete(callback)
    }
  }, [])

  const refreshAll = useCallback((options = {}) => {
    const { silent = false, force = false } = options
    
    // Дебаунсинг: не чаще 1 раза в секунду, если не force
    const now = Date.now()
    if (!force && now - lastRefreshTimeRef.current < 1000) {
      if (!pendingRefreshRef.current) {
        pendingRefreshRef.current = true
        setTimeout(() => {
          pendingRefreshRef.current = false
          refreshAll({ silent, force: true })
        }, 1000 - (now - lastRefreshTimeRef.current))
      }
      return
    }

    lastRefreshTimeRef.current = now

    // Используем requestAnimationFrame для плавного обновления без дерганий
    requestAnimationFrame(() => {
      if (!silent) {
        setRefreshKey(prev => prev + 1)
      }
      
      // Вызываем все зарегистрированные callback'и с silent режимом
      refreshCallbacksRef.current.forEach(callback => {
        if (typeof callback === 'function') {
          try {
            callback(silent)
          } catch (error) {
            console.error('Error in refresh callback:', error)
          }
        }
      })
    })
  }, [])

  // Резервное обновление по таймеру (основное — по WebSocket)
  useEffect(() => {
    if (autoRefreshEnabled) {
      autoRefreshIntervalRef.current = setInterval(() => {
        refreshAll({ silent: true })
      }, 15000)
    }

    return () => {
      if (autoRefreshIntervalRef.current) {
        clearInterval(autoRefreshIntervalRef.current)
      }
    }
  }, [autoRefreshEnabled, refreshAll])

  // Обновление при фокусе на вкладке
  useEffect(() => {
    const REFRESH_COOLDOWN_MS = 10000

    const handleVisibilityChange = () => {
      if (!document.hidden && autoRefreshEnabled) {
        const now = Date.now()
        if (now - lastVisibilityRefreshRef.current < REFRESH_COOLDOWN_MS) return
        lastVisibilityRefreshRef.current = now
        refreshAll({ silent: true })
      }
    }

    const handleFocus = () => {
      if (autoRefreshEnabled) {
        const now = Date.now()
        if (now - lastVisibilityRefreshRef.current < REFRESH_COOLDOWN_MS) return
        lastVisibilityRefreshRef.current = now
        refreshAll({ silent: true })
      }
    }

    document.addEventListener('visibilitychange', handleVisibilityChange)
    window.addEventListener('focus', handleFocus)

    return () => {
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      window.removeEventListener('focus', handleFocus)
    }
  }, [autoRefreshEnabled, refreshAll])

  return (
    <DataRefreshContext.Provider value={{
      refreshKey,
      refreshAll,
      registerRefreshCallback,
      autoRefreshEnabled,
      setAutoRefreshEnabled
    }}>
      {children}
    </DataRefreshContext.Provider>
  )
}
