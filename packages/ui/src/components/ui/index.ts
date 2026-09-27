import type { ExternalToast } from 'sonner'
import { reportClientError } from '@/lib/clientErrorReport'
import { toast as shownToast } from './toast'

// Every error toast a person sees also reaches the fleet (smarty-code#536): the page's error, never its content.
// ponytail: wrapped here, not in the branded toast module, which keeps its reviewed baseline.
const toastText = (message: unknown, data?: ExternalToast): string => {
  const description = typeof data?.description === 'string' ? data.description : ''
  return typeof message === 'string' ? (description ? `${message}: ${description}` : message) : description
}
export const toast: typeof shownToast = {
  ...shownToast,
  error: (message, data) => {
    reportClientError({ kind: 'toast', message: toastText(message, data) })
    return shownToast.error(message, data)
  },
}
