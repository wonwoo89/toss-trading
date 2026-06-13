import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

export type ToastVariant = 'success' | 'error' | 'info'

interface ToastItem {
  id: string
  message: string
  variant: ToastVariant
}

interface ToastContextValue {
  showToast: (message: string, variant?: ToastVariant) => void
}

const ToastContext = createContext<ToastContextValue | null>(null)

const MAX_TOASTS = 3
const TOAST_DURATION_MS = 4200
const TOAST_EXIT_MS = 220

function ToastStack({
  toasts,
  exitingIds,
  onDismiss,
}: {
  toasts: ToastItem[]
  exitingIds: Set<string>
  onDismiss: (id: string) => void
}) {
  const stackRef = useRef<HTMLDivElement>(null)
  const positionsRef = useRef(new Map<string, number>())

  useLayoutEffect(() => {
    const stack = stackRef.current
    if (!stack) return

    const nextPositions = new Map<string, number>()
    const items = stack.querySelectorAll<HTMLElement>('[data-toast-id]')

    items.forEach((element) => {
      const id = element.dataset.toastId
      if (!id) return

      const nextTop = element.offsetTop
      const previousTop = positionsRef.current.get(id)

      if (previousTop !== undefined && previousTop !== nextTop) {
        const delta = previousTop - nextTop
        element.animate(
          [
            { transform: `translateY(${delta}px)` },
            { transform: 'translateY(0)' },
          ],
          {
            duration: 280,
            easing: 'cubic-bezier(0.22, 1, 0.36, 1)',
          },
        )
      }

      nextPositions.set(id, nextTop)
    })

    positionsRef.current = nextPositions
  }, [toasts])

  return (
    <div ref={stackRef} className="toast-stack" aria-live="polite" aria-relevant="additions">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          data-toast-id={toast.id}
          className={`toast-item toast-item--${toast.variant}${exitingIds.has(toast.id) ? ' is-exiting' : ''}`}
          role="status"
        >
          <p className="toast-item__message">{toast.message}</p>
          <button
            type="button"
            className="toast-item__close"
            aria-label="알림 닫기"
            onClick={() => onDismiss(toast.id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  )
}

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([])
  const [exitingIds, setExitingIds] = useState<Set<string>>(() => new Set())
  const timersRef = useRef(new Map<string, ReturnType<typeof setTimeout>>())

  const dismissToast = useCallback((id: string) => {
    const timer = timersRef.current.get(id)
    if (timer) {
      clearTimeout(timer)
      timersRef.current.delete(id)
    }

    setExitingIds((prev) => {
      if (prev.has(id)) return prev
      const next = new Set(prev)
      next.add(id)
      return next
    })

    setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id))
      setExitingIds((prev) => {
        if (!prev.has(id)) return prev
        const next = new Set(prev)
        next.delete(id)
        return next
      })
    }, TOAST_EXIT_MS)
  }, [])

  useEffect(() => {
    const timers = timersRef.current
    return () => {
      timers.forEach((timer) => clearTimeout(timer))
      timers.clear()
    }
  }, [])

  const showToast = useCallback(
    (message: string, variant: ToastVariant = 'success') => {
      const id = crypto.randomUUID()

      setToasts((prev) => [{ id, message, variant }, ...prev].slice(0, MAX_TOASTS))

      const timer = setTimeout(() => {
        dismissToast(id)
      }, TOAST_DURATION_MS)
      timersRef.current.set(id, timer)
    },
    [dismissToast],
  )

  const value = useMemo(() => ({ showToast }), [showToast])

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="toast-viewport">
        <ToastStack toasts={toasts} exitingIds={exitingIds} onDismiss={dismissToast} />
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const context = useContext(ToastContext)
  if (!context) {
    throw new Error('useToast must be used within ToastProvider')
  }
  return context
}