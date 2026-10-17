import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { Loader2, Lock, Server, User } from 'lucide-react';

import { useAuth } from '@/modules/auth/context/AuthContext';
import AuthErrorAlert from '@/modules/auth/AuthErrorAlert';
import AuthInputField from '@/modules/auth/AuthInputField';
import AuthScreenLayout from '@/modules/auth/AuthScreenLayout';
import { FrontendBridge, isDesktop } from '@/shared/chisa';

type LoginFormState = {
  serverUrl: string;
  username: string;
  password: string;
};

const initialState: LoginFormState = {
  serverUrl: '',
  username: '',
  password: '',
};

/**
 * Login form component.
 * Rendered by ProtectedRoute on the web and embedded by AccountPopup on desktop when no session exists.
 * Handles credential input with browser autofill support (`autocomplete`
 * attributes) so that password managers can offer to fill saved credentials.
 */
export default function LoginForm({ embedded = false }: { embedded?: boolean } = {}) {
  const { t } = useTranslation('auth');
  const { error: sessionError, login } = useAuth();
  const desktop = isDesktop();

  // Desktop sign-in includes the service address so no separate setup step is needed.
  const [formState, setFormState] = useState<LoginFormState>(initialState);
  // Address and account failures stay beside the single sign-in action.
  const [errorMessage, setErrorMessage] = useState('');
  // Keep address and credentials fixed while connecting and signing in.
  const [isSubmitting, setIsSubmitting] = useState(false);
  // Wait for the saved/default native address before the user can submit it.
  const [isLoadingAddress, setIsLoadingAddress] = useState(desktop);

  useEffect(() => {
    if (!desktop) return;
    let active = true;
    void FrontendBridge.getState().then((state) => {
      if (active) setFormState(previous => ({ ...previous, serverUrl: state.serverUrl || '' }));
    }).catch(() => {
      if (active) setErrorMessage(t('login.errors.serverAddressRead'));
    }).finally(() => {
      if (active) setIsLoadingAddress(false);
    });
    return () => { active = false; };
  }, [desktop, t]);

  const updateField = useCallback((field: keyof LoginFormState, value: string) => {
    setFormState((previous) => ({ ...previous, [field]: value }));
  }, []);

  const handleSubmit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      if (isSubmitting || isLoadingAddress) return;
      setErrorMessage('');

      // Keep form validation local so each auth screen owns its own UI feedback.
      if ((desktop && !formState.serverUrl.trim()) || !formState.username.trim() || !formState.password) {
        setErrorMessage(t('login.errors.requiredFields'));
        return;
      }

      setIsSubmitting(true);
      try {
        if (desktop) {
          const connection = await FrontendBridge.connectServer(formState.serverUrl.trim());
          if (connection.ok !== true) throw new Error(String(connection.error || t('login.errors.networkError')));
        }
        const result = await login(formState.username.trim(), formState.password);
        if (!result.success) setErrorMessage(result.error);
      } catch (error) {
        setErrorMessage(error instanceof Error ? error.message : t('login.errors.networkError'));
      } finally {
        setIsSubmitting(false);
      }
    },
    [desktop, formState.password, formState.serverUrl, formState.username, isLoadingAddress, isSubmitting, login, t],
  );

  const form = (
      <form onSubmit={handleSubmit} className="space-y-4">
        {desktop && <AuthInputField
          id="server-address"
          label={t('login.serverAddress')}
          value={formState.serverUrl}
          onChange={(value) => updateField('serverUrl', value)}
          placeholder={t('login.placeholders.serverAddress')}
          isDisabled={isSubmitting || isLoadingAddress}
          type="url"
          autoComplete="url"
          icon={Server}
        />}
        <AuthInputField
          id="username"
          label={t('login.username')}
          value={formState.username}
          onChange={(value) => updateField('username', value)}
          placeholder={t('login.placeholders.username')}
          isDisabled={isSubmitting || isLoadingAddress}
          autoComplete="username"
          icon={User}
        />

        <AuthInputField
          id="password"
          label={t('login.password')}
          value={formState.password}
          onChange={(value) => updateField('password', value)}
          placeholder={t('login.placeholders.password')}
          isDisabled={isSubmitting || isLoadingAddress}
          type="password"
          autoComplete="current-password"
          icon={Lock}
        />

        <AuthErrorAlert errorMessage={errorMessage || sessionError || ''} />

        <button
          type="submit"
          disabled={isSubmitting || isLoadingAddress}
          className="flex w-full items-center justify-center gap-2 rounded-xl bg-primary px-4 py-2.5 font-medium text-primary-foreground shadow-lg shadow-primary/25 transition-all duration-200 hover:shadow-primary/30 hover:brightness-110 focus:outline-none focus:ring-2 focus:ring-primary/40 focus:ring-offset-2 focus:ring-offset-card active:scale-[0.99] disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isSubmitting || isLoadingAddress ? (
            <>
              <Loader2 className="h-4 w-4 animate-spin" />
              {t(isLoadingAddress ? 'login.loadingAddress' : 'login.loading')}
            </>
          ) : (
            t('login.submit')
          )}
        </button>
      </form>
  );
  return embedded ? form : (
    <AuthScreenLayout title={t('login.title')} description={t('login.description')} footerText={t('login.footerText')}>
      {form}
    </AuthScreenLayout>
  );
}
