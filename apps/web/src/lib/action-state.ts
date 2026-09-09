/**
 * Shared shape for what a Server Action reports back to its form.
 *
 * It lives outside `admin-actions.ts` because a `'use server'` module may only
 * export async functions — every other export there would be reachable as a
 * remotely callable endpoint, so Next.js rejects the file outright.
 */
export interface ActionState {
  status: 'idle' | 'ok' | 'error'
  message: string
}

export const idleState: ActionState = { status: 'idle', message: '' }
