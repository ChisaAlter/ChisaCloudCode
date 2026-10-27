import type { ReactNode } from 'react';

import { IS_PLATFORM } from '@/shared/utils';
import { useAuth } from '@/modules/auth/context/AuthContext';
import { Onboarding } from '@/modules/onboarding';
import AuthLoadingScreen from '@/modules/auth/AuthLoadingScreen';
import LoginForm from '@/modules/auth/LoginForm';
import { SignedOutDesktop } from '@/modules/auth/SignedOutDesktop';
import { isDesktop } from '@/shared/chisa';

type ProtectedRouteProps = {
  children: ReactNode;
};

/** Used by App to gate the routed application behind login and the signed-in onboarding flow. */
export default function ProtectedRoute({ children }: ProtectedRouteProps) {
  const { user, isLoading, hasCompletedOnboarding, refreshOnboardingStatus } = useAuth();

  if (isLoading && !user) {
    return <AuthLoadingScreen />;
  }

  if (IS_PLATFORM) {
    if (!hasCompletedOnboarding) {
      return <Onboarding onComplete={refreshOnboardingStatus} />;
    }

    return <>{children}</>;
  }

  if (!user) {
    return isDesktop() ? <SignedOutDesktop /> : <LoginForm />;
  }

  if (!hasCompletedOnboarding) {
    return <Onboarding onComplete={refreshOnboardingStatus} />;
  }

  return <>{children}</>;
}
