import React, { createContext, useContext, useState, useEffect, useCallback } from 'react'
import { authService } from '../services/authService'
import { isAccessTokenExpired } from '../config/api'

const AuthContext = createContext(null)

export const useAuth = () => {
  const context = useContext(AuthContext)
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider')
  }
  return context
}

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null)
  const [accessToken, setAccessToken] = useState(localStorage.getItem('accessToken'))
  const [refreshToken, setRefreshToken] = useState(localStorage.getItem('refreshToken'))
  const [loading, setLoading] = useState(true)
  const [showHelloAfterLogin, setShowHelloAfterLogin] = useState(false)

  useEffect(() => {
    let mounted = true

    const initAuth = async () => {
      const storedAccess = localStorage.getItem('accessToken')
      const storedRefresh = localStorage.getItem('refreshToken')

      if (!storedAccess) {
        if (mounted) setLoading(false)
        return
      }

      // До рендера защищённых экранов убеждаемся, что access token рабочий.
      if (isAccessTokenExpired(storedAccess) && storedRefresh) {
        try {
          const data = await authService.refreshToken(storedRefresh)
          if (!mounted) return

          setAccessToken(data.accessToken)
          setRefreshToken(storedRefresh)
          localStorage.setItem('accessToken', data.accessToken)

          if (data.user) {
            setUser(data.user)
            localStorage.setItem('userInfo', JSON.stringify(data.user))
          } else {
            const storedUser = localStorage.getItem('userInfo')
            if (storedUser) {
              setUser(JSON.parse(storedUser))
            } else {
              setUser({ token: data.accessToken })
            }
          }
        } catch {
          if (!mounted) return
          setAccessToken(null)
          setRefreshToken(null)
          setUser(null)
          localStorage.removeItem('accessToken')
          localStorage.removeItem('refreshToken')
          localStorage.removeItem('userInfo')
        } finally {
          if (mounted) setLoading(false)
        }
        return
      }

      if (!isAccessTokenExpired(storedAccess)) {
        try {
          const stored = localStorage.getItem('userInfo')
          if (stored) {
            setUser(JSON.parse(stored))
          } else {
            setUser({ token: storedAccess })
          }
        } catch {
          setUser({ token: storedAccess })
        }
      } else {
        setAccessToken(null)
        setRefreshToken(null)
        setUser(null)
        localStorage.removeItem('accessToken')
        localStorage.removeItem('refreshToken')
        localStorage.removeItem('userInfo')
      }

      if (mounted) setLoading(false)
    }

    initAuth()
    return () => {
      mounted = false
    }
  }, [])

  const login = async (username, password) => {
    try {
      const data = await authService.login(username, password)
      
      setAccessToken(data.accessToken)
      setRefreshToken(data.refreshToken)
      setUser(data.user)
      setShowHelloAfterLogin(true)
      
      localStorage.setItem('accessToken', data.accessToken)
      localStorage.setItem('refreshToken', data.refreshToken)
      if (data.user) localStorage.setItem('userInfo', JSON.stringify(data.user))
      
      return { success: true }
    } catch (error) {
      return { success: false, error: error.message }
    }
  }

  const clearShowHello = () => setShowHelloAfterLogin(false)

  const logout = () => {
    setAccessToken(null)
    setRefreshToken(null)
    setUser(null)
    localStorage.removeItem('accessToken')
    localStorage.removeItem('refreshToken')
    localStorage.removeItem('userInfo')
  }

  const refreshAccessToken = useCallback(async () => {
    const rtk = refreshToken || localStorage.getItem('refreshToken')
    if (!rtk) {
      logout()
      return false
    }

    try {
      const data = await authService.refreshToken(rtk)
      setAccessToken(data.accessToken)
      setRefreshToken(rtk)
      localStorage.setItem('accessToken', data.accessToken)
      if (data.user) {
        setUser(prev => {
          const merged = { ...prev, ...data.user }
          localStorage.setItem('userInfo', JSON.stringify(merged))
          return merged
        })
      }
      return true
    } catch (_error) {
      logout()
      return false
    }
  }, [refreshToken])

  /** Обновляет access token, если он истёк (чтобы не получать 403 при запросах) */
  const ensureValidToken = useCallback(async () => {
    const token = localStorage.getItem('accessToken')
    if (!token) return
    if (!isAccessTokenExpired(token)) return
    await refreshAccessToken()
  }, [refreshAccessToken])

  const value = {
    user,
    accessToken,
    isAuthenticated: !!accessToken,
    login,
    logout,
    refreshAccessToken,
    ensureValidToken,
    loading,
    showHelloAfterLogin,
    clearShowHello
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
