import { useState, useEffect, useRef, useCallback } from 'react'

const STORAGE_KEY = 'purchaseHistory_searchName'
const DEBOUNCE_MS = 500

/**
 * Хук поиска в истории покупок.
 * Управляет состоянием, debounce, localStorage и восстановлением фокуса.
 *
 * @param {Object} options
 * @param {() => void} [options.onDebouncedChange] - вызывается при изменении debounced-значения (для сброса страницы и т.п.)
 * @param {boolean} [options.isInitialLoad] - флаг первой загрузки (не сбрасывает страницу при первом debounce)
 */
export function usePurchaseHistorySearch(options = {}) {
  const { onDebouncedChange, isInitialLoadRef } = options

  const [value, setValue] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || ''
    } catch {
      return ''
    }
  })

  const [debouncedValue, setDebouncedValue] = useState(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) || ''
    } catch {
      return ''
    }
  })

  const debounceTimerRef = useRef(null)
  const inputRef = useRef(null)
  const wasFocusedRef = useRef(false)
  const cursorPositionRef = useRef(null)
  const isUserTypingRef = useRef(false)

  useEffect(() => {
    try {
      if (value) {
        localStorage.setItem(STORAGE_KEY, value)
      } else {
        localStorage.removeItem(STORAGE_KEY)
      }
    } catch (e) {
      // игнорируем ошибки localStorage
    }
  }, [value])

  useEffect(() => {
    if (debounceTimerRef.current) {
      clearTimeout(debounceTimerRef.current)
    }

    if (inputRef.current && document.activeElement === inputRef.current) {
      wasFocusedRef.current = true
      cursorPositionRef.current = inputRef.current.selectionStart
      isUserTypingRef.current = true
    }

    debounceTimerRef.current = setTimeout(() => {
      setDebouncedValue(value)
      if (!isInitialLoadRef?.current) {
        onDebouncedChange?.()
      }
      isUserTypingRef.current = false
    }, DEBOUNCE_MS)

    return () => {
      if (debounceTimerRef.current) {
        clearTimeout(debounceTimerRef.current)
      }
    }
  }, [value, onDebouncedChange, isInitialLoadRef])

  const clear = useCallback(() => {
    setValue('')
    setDebouncedValue('')
    try {
      localStorage.removeItem(STORAGE_KEY)
    } catch (e) {
      // игнорируем
    }
  }, [])

  const handleChange = useCallback((e) => {
    cursorPositionRef.current = e.target.selectionStart
    isUserTypingRef.current = true
    setValue(e.target.value)
  }, [])

  const handleFocus = useCallback((e) => {
    wasFocusedRef.current = true
    if (cursorPositionRef.current !== null) {
      setTimeout(() => {
        e.target.setSelectionRange(cursorPositionRef.current, cursorPositionRef.current)
      }, 0)
    }
  }, [])

  const handleBlur = useCallback(() => {
    wasFocusedRef.current = false
  }, [])

  const restoreFocusIfNeeded = useCallback(() => {
    if (!isUserTypingRef.current || !wasFocusedRef.current || !inputRef.current || value.length === 0) {
      return
    }
    const savedPosition = cursorPositionRef.current !== null
      ? cursorPositionRef.current
      : inputRef.current.value.length
    if (inputRef.current.value === value) {
      inputRef.current.focus()
      const position = Math.min(savedPosition, inputRef.current.value.length)
      inputRef.current.setSelectionRange(position, position)
    }
    wasFocusedRef.current = false
    isUserTypingRef.current = false
  }, [value])

  return {
    value,
    debouncedValue,
    clear,
    inputRef,
    isUserTypingRef,
    restoreFocusIfNeeded,
    handleChange,
    handleFocus,
    handleBlur
  }
}
