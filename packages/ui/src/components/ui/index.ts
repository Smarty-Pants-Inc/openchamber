import { reportClientError } from '@/lib/clientErrorReport'
import { toast as shownToast } from './toast'

// Every error toast a person sees also reaches the fleet (smarty-code#536): the page's error, never its content.
// ponytail: wrapped here, not in the branded toast module, which keeps its reviewed baseline.
export const toast: typeof shownToast = {
  ...shownToast,
  error: (message, data) => {
    // A toast's text is built by many callers and can hold the person's content (a file, a branch, a title): it is not
    // sent. The fleet sees that an error was shown, where and when; the paths that matter report their own diagnostic.
    reportClientError({ kind: 'toast' })
    return shownToast.error(message, data)
  },
}
