import React from 'react'

/**
 * Поле поиска для истории покупок.
 * Ищет по имени/фамилии клиента, названию товара и категории.
 */
export function PurchaseHistorySearchInput({
  value,
  onChange,
  onFocus,
  onBlur,
  inputRef,
  id = 'searchName',
  placeholder = 'Имя, фамилия, товар или категория',
  className = 'text-input'
}) {
  return (
    <div className="filter-group">
      <label htmlFor={id}>Поиск:</label>
      <input
        ref={inputRef}
        id={id}
        type="text"
        value={value}
        onChange={onChange}
        onFocus={onFocus}
        onBlur={onBlur}
        placeholder={placeholder}
        className={className}
      />
    </div>
  )
}
