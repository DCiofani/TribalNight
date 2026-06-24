// TEMP — swappabile quando arriva il design (Claude Design).
// Bottone token-driven, full-width mobile, focus visibile.
'use client';

import React from 'react';

type ButtonProps = {
  children: React.ReactNode;
  variant?: 'primary' | 'ghost';
  disabled?: boolean;
  onClick?: () => void;
  type?: 'button' | 'submit' | 'reset';
};

export default function Button({
  children,
  variant = 'primary',
  disabled = false,
  onClick,
  type = 'button',
}: ButtonProps) {
  const base: React.CSSProperties = {
    width: '100%',
    padding: '14px 20px',
    borderRadius: 12,
    fontSize: 16,
    fontWeight: 600,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.5 : 1,
    transition: 'transform 120ms cubic-bezier(0.16,1,0.3,1), opacity 120ms',
    // focus visibile: outline ad alto contrasto col token lavanda
    outlineColor: 'var(--eden-lavender)',
  };

  const byVariant: Record<NonNullable<ButtonProps['variant']>, React.CSSProperties> = {
    primary: {
      background: 'var(--eden-violet)',
      color: 'var(--ink-0)',
      border: '1px solid var(--eden-violet)',
    },
    ghost: {
      background: 'transparent',
      color: 'var(--ink-0)',
      border: '1px solid var(--night-700)',
    },
  };

  return (
    <button
      type={type}
      onClick={onClick}
      disabled={disabled}
      className="btn"
      style={{ ...base, ...byVariant[variant] }}
    >
      {children}
    </button>
  );
}
