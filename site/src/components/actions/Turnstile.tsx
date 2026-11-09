/**
 * Cloudflare Turnstile ("I am human") widget. Loads the script only when a
 * form that needs it is opened, and reports the token to the parent.
 */
import { useEffect, useRef, useState } from 'preact/hooks';

declare global {
  interface Window {
    turnstile?: {
      render: (el: HTMLElement, opts: Record<string, unknown>) => string;
      reset: (id?: string) => void;
      remove: (id: string) => void;
    };
  }
}

let scriptPromise: Promise<void> | undefined;
function loadScript(): Promise<void> {
  scriptPromise ??= new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
    s.async = true;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error('Could not load the human check.'));
    document.head.appendChild(s);
  });
  return scriptPromise;
}

let siteKeyPromise: Promise<string | null> | undefined;
function siteKey(): Promise<string | null> {
  siteKeyPromise ??= fetch('/api/config')
    .then((r) => (r.ok ? r.json() : { turnstileSiteKey: null }))
    .then((c: { turnstileSiteKey: string | null }) => c.turnstileSiteKey)
    .catch(() => null);
  return siteKeyPromise;
}

export function Turnstile({
  onToken,
  resetKey,
}: {
  onToken: (t: string | null) => void;
  resetKey?: number;
}) {
  const el = useRef<HTMLDivElement>(null);
  const widget = useRef<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const key = await siteKey();
      if (!key) {
        setError('Requests are not enabled on this site yet.');
        return;
      }
      try {
        await loadScript();
      } catch (e) {
        setError((e as Error).message);
        return;
      }
      if (cancelled || !el.current || !window.turnstile) return;
      widget.current = window.turnstile.render(el.current, {
        sitekey: key,
        callback: (t: string) => onToken(t),
        'expired-callback': () => onToken(null),
        'error-callback': () => onToken(null),
      });
    })();
    return () => {
      cancelled = true;
      if (widget.current && window.turnstile) window.turnstile.remove(widget.current);
    };
  }, []);

  useEffect(() => {
    if (resetKey && widget.current && window.turnstile) {
      window.turnstile.reset(widget.current);
      onToken(null);
    }
  }, [resetKey]);

  return (
    <div>
      <div ref={el} />
      {error && <p class="act-err">{error}</p>}
    </div>
  );
}
