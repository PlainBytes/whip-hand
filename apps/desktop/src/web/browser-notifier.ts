/**
 * Notifier backed by the browser's Notification API.
 *
 * More valuable here than on the desktop: the whole point of reaching Mission
 * Control from another machine is not sitting in front of the run, so being
 * told when a step wants an answer is the difference between checking back and
 * watching. Permission is requested lazily, on the first notification, rather
 * than with a prompt the moment the page loads.
 */
import { noopNotifier, type Notifier } from '../lib/notifier.ts';

export function createBrowserNotifier(): Notifier {
  if (typeof window === 'undefined' || !('Notification' in window)) return noopNotifier;
  let permitted: boolean | null = null;
  return (title, body) => {
    void (async () => {
      if (permitted === null) {
        permitted = Notification.permission === 'granted';
        if (!permitted && Notification.permission !== 'denied') {
          permitted = (await Notification.requestPermission()) === 'granted';
        }
      }
      if (permitted) new Notification(title, { body });
    })().catch(() => {});
  };
}
