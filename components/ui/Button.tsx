// Bottone token-driven, full-width mobile, focus visibile.
'use client';

import React from 'react';

type ButtonProps = {
  children: React.ReactNode;
  variant?: 'primary' | 'ghost' | 'gold' | 'indigo';
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
    padding: '15px 20px',
    borderRadius: 12,
    fontFamily: 'var(--font-ui)',
    fontSize: 16,
    fontWeight: 600,
    letterSpacing: '0.01em',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.45 : 1,
    transition: 'transform 120ms cubic-bezier(0.16,1,0.3,1), filter 120ms, opacity 120ms',
    outlineColor: 'var(--eden-lavender)',
  };

  const byVariant: Record<NonNullable<ButtonProps['variant']>, React.CSSProperties> = {
    primary: {
      background: 'linear-gradient(180deg, #f0712f, #d6471d)',
      color: '#fff',
      border: '1px solid rgba(255,180,110,0.5)',
      boxShadow: '0 6px 22px -8px rgba(224,85,42,0.7), inset 0 1px 0 rgba(255,220,180,0.35)',
    },
    gold: {
      background: 'linear-gradient(180deg, #f7d06a, #e3a92f)',
      color: '#2a1604',
      border: '1px solid rgba(255,228,150,0.6)',
      boxShadow: '0 6px 22px -8px rgba(245,196,81,0.6), inset 0 1px 0 rgba(255,245,210,0.5)',
    },
    indigo: {
      background: 'linear-gradient(180deg, #4a6ad0, #324fa8)',
      color: '#fff',
      border: '1px solid rgba(150,170,235,0.5)',
      boxShadow: '0 6px 22px -8px rgba(58,91,190,0.6)',
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
