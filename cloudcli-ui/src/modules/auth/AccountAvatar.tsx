import { UserRound } from 'lucide-react';

import type { AuthUserProfile } from '@/shared/types';

/** Auth and sidebar use the saved account picture with a neutral guest fallback. */
export function AccountAvatar({ user, className = 'h-8 w-8' }: { user: AuthUserProfile | null; className?: string }) {
  return (
    <span className={`inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted ${className}`}>
      {user?.avatarDataUrl
        ? <img src={user.avatarDataUrl} alt="" className="h-full w-full object-cover" />
        : <UserRound className="h-1/2 w-1/2 text-muted-foreground" />}
    </span>
  );
}
