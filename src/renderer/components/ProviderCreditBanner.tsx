import { type FC, useEffect, useState } from 'react'
import { FontAwesomeIcon } from '@fortawesome/react-fontawesome'
import { faTriangleExclamation } from '@fortawesome/free-solid-svg-icons'
import type { CreditBreakerState } from '../../shared/types'

// When the provider runs out of credit the app stops calling it, and everything
// that depends on a model — chat, indexing, the hourly passes — quietly does
// nothing. Without this the only symptom is an app that has gone still, so the
// reason is stated where it cannot be missed, along with the one action that
// clears it.
export const ProviderCreditBanner: FC = () => {
  const [state, setState] = useState<CreditBreakerState | null>(null)

  useEffect(() => {
    void window.electronAPI.providerCredit.get().then(setState)
    return window.electronAPI.providerCredit.onState(setState)
  }, [])

  if (!state?.tripped) return null

  const handleRetry = async (): Promise<void> => {
    await window.electronAPI.providerCredit.clear()
    setState(await window.electronAPI.providerCredit.get())
  }

  return (
    <div className="shrink-0 border-b border-amber-300/25 bg-amber-300/[0.07] px-4 py-2">
      <div className="flex items-center gap-3">
        <FontAwesomeIcon icon={faTriangleExclamation} className="text-[12px] text-amber-300/80" />
        <div className="min-w-0 flex-1">
          <p className="text-[12px] text-amber-100/85">
            Provider calls are paused — the account has no credit.
          </p>
          {state.message && (
            <p className="truncate text-[11px] text-amber-200/50" title={state.message}>
              {state.message}
            </p>
          )}
        </div>
        <button
          onClick={() => void handleRetry()}
          className="shrink-0 rounded-md border border-amber-300/30 px-2.5 py-1 text-[11px] text-amber-100/80 transition-colors hover:border-amber-300/60 hover:text-amber-50 cursor-pointer"
        >
          Try again
        </button>
      </div>
    </div>
  )
}
