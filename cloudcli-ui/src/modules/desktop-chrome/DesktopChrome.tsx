import { useEffect } from 'react';

import { isDesktop } from '@/shared/chisa';
import '@/modules/desktop-chrome/desktop-chrome.css';

/** Mounted by App to reserve native caption controls and allow dragging on the auth screen. */
export function DesktopChrome() {
  const desktop = isDesktop();
  useEffect(() => {
    document.documentElement.classList.toggle('desktop-app', desktop);
    return () => document.documentElement.classList.remove('desktop-app');
  }, [desktop]);

  return desktop ? <div className="desktop-auth-titlebar desktop-drag" aria-hidden="true" /> : null;
}
