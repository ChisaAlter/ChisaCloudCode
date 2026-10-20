import { Terminal } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import LoginForm from '@/modules/auth/LoginForm';
import '@/modules/auth/desktop-login.css';

/** ProtectedRoute uses this focused entry screen before opening the desktop workspace. */
export function SignedOutDesktop() {
  const { t } = useTranslation('auth');
  return (
    <div className="desktop-signed-out desktop-login">
      <main className="desktop-login-main">
        <div className="desktop-login-content">
          <div className="desktop-login-brand">
            <span className="desktop-login-mark" aria-hidden="true"><Terminal size={21} strokeWidth={1.7} /></span>
            <span>ChisaCloudCode</span>
          </div>
          <section className="desktop-login-card" aria-labelledby="desktop-login-title">
            <header className="desktop-login-heading">
              <h1 id="desktop-login-title">{t('desktop.title')}</h1>
              <p>{t('desktop.description')}</p>
            </header>
            <LoginForm embedded />
          </section>
          <p className="desktop-login-footer">{t('desktop.footer')}</p>
        </div>
      </main>
    </div>
  );
}
