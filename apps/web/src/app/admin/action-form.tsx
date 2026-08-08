'use client'

import { useActionState } from 'react'
import { useFormStatus } from 'react-dom'
import type { ReactNode } from 'react'

import { idleState, type ActionState } from '../../lib/action-state'

/**
 * Wraps a Server Action in a form that reports its own outcome inline.
 *
 * Provider governance is a sequence — register a key, create a configuration,
 * activate it, attest its health — and each step's result tells the operator
 * whether the next one is worth attempting. Replacing the page with an error
 * screen would lose that thread, so the result renders next to the form.
 */
export function ActionForm({
  action,
  submitLabel,
  children,
}: Readonly<{
  action: (previous: ActionState, form: FormData) => Promise<ActionState>
  submitLabel: string
  children: ReactNode
}>) {
  const [state, dispatch] = useActionState(action, idleState)
  return (
    <form action={dispatch} className="action-form">
      {children}
      <SubmitButton label={submitLabel} />
      {state.status !== 'idle' && (
        <p className={`form-message ${state.status}`} role="status">
          {state.message}
        </p>
      )}
    </form>
  )
}

function SubmitButton({ label }: Readonly<{ label: string }>) {
  const { pending } = useFormStatus()
  return (
    <button type="submit" disabled={pending}>
      {pending ? 'در حال انجام…' : label}
    </button>
  )
}

export function Field({
  label,
  name,
  hint,
  ...input
}: Readonly<{
  label: string
  name: string
  hint?: string
  type?: string
  required?: boolean
  defaultValue?: string
  placeholder?: string
  inputMode?: 'text' | 'numeric' | 'tel'
  pattern?: string
  dir?: 'rtl' | 'ltr'
}>) {
  return (
    <label className="field">
      <span>{label}</span>
      <input id={name} name={name} {...input} />
      {hint && <small>{hint}</small>}
    </label>
  )
}

export function SelectField({
  label,
  name,
  options,
  hint,
  defaultValue,
}: Readonly<{
  label: string
  name: string
  options: ReadonlyArray<{ value: string; label: string }>
  hint?: string
  defaultValue?: string
}>) {
  return (
    <label className="field">
      <span>{label}</span>
      <select id={name} name={name} defaultValue={defaultValue}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {hint && <small>{hint}</small>}
    </label>
  )
}

export function TextAreaField({
  label,
  name,
  hint,
  defaultValue,
  rows = 3,
  maxLength,
}: Readonly<{
  label: string
  name: string
  hint?: string
  defaultValue?: string
  rows?: number
  maxLength?: number
}>) {
  return (
    <label className="field">
      <span>{label}</span>
      <textarea
        id={name}
        name={name}
        rows={rows}
        maxLength={maxLength}
        defaultValue={defaultValue}
      />
      {hint && <small>{hint}</small>}
    </label>
  )
}
