import { useEffect, useRef, useState } from 'react';
import type { ChangeEvent, FormEvent } from 'react';
import { Loader2, LogOut, Upload } from 'lucide-react';

import { useAuth } from '@/modules/auth/context/AuthContext';
import { AccountAvatar } from '@/modules/auth/AccountAvatar';
import { Button } from '@/shared/ui';
import { getAuthSessionVersion } from '@/shared/authToken';

/** AccountPopup renders this editor to persist the signed-in identity on the server. */
export function AccountProfileEditor() {
  const { user, updateProfile, logout } = useAuth();
  const fileRef = useRef<HTMLInputElement>(null);
  // Unsaved display identity stays in the form until the server accepts it.
  const [displayName, setDisplayName] = useState(user?.displayName || user?.username || '');
  // The selected raster image is previewed before persisting its data with the account.
  const [avatarDataUrl, setAvatarDataUrl] = useState<string | null>(user?.avatarDataUrl || null);
  // Feedback distinguishes a saved server profile from a draft or failed save.
  const [feedback, setFeedback] = useState<{ error: boolean; message: string } | null>(null);
  // Prevent duplicate submissions while the current profile write is pending.
  const [isSaving, setIsSaving] = useState(false);
  // A preview is not a persistable avatar until FileReader finishes for this selection.
  const [isReadingAvatar, setIsReadingAvatar] = useState(false);
  const avatarReader = useRef<FileReader | null>(null);
  const savingRef = useRef(false);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => { alive.current = false; avatarReader.current?.abort(); };
  }, []);

  const chooseAvatar = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setFeedback(null);
    if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(file.type)) {
      setFeedback({ error: true, message: '请选择 PNG、JPEG、WebP 或 GIF 图片' });
      return;
    }
    if (file.size > 2 * 1024 * 1024) {
      setFeedback({ error: true, message: '头像不能超过 2 MB' });
      return;
    }
    avatarReader.current?.abort();
    const reader = new FileReader();
    const identity = getAuthSessionVersion();
    avatarReader.current = reader;
    setIsReadingAvatar(true);
    const current = () => alive.current && avatarReader.current === reader && identity === getAuthSessionVersion();
    reader.onload = () => {
      if (!current()) return;
      setAvatarDataUrl(String(reader.result));
      avatarReader.current = null;
      setIsReadingAvatar(false);
    };
    reader.onerror = () => {
      if (!current()) return;
      avatarReader.current = null;
      setIsReadingAvatar(false);
      setFeedback({ error: true, message: '读取图片失败，请重新选择' });
    };
    reader.readAsDataURL(file);
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (savingRef.current || avatarReader.current) return;
    savingRef.current = true;
    setFeedback(null);
    setIsSaving(true);
    const result = await updateProfile(displayName.trim(), avatarDataUrl);
    savingRef.current = false;
    if (!alive.current) return;
    setIsSaving(false);
    setFeedback(result.success
      ? { error: false, message: '账户资料已保存到服务器' }
      : { error: true, message: result.error });
  };

  if (!user) return null;
  const previewUser = { ...user, avatarDataUrl };
  return (
    <form onSubmit={save} className="space-y-5">
      <div className="flex items-center gap-4">
        <AccountAvatar user={previewUser} className="h-16 w-16" />
        <div className="min-w-0 space-y-2">
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" size="sm" disabled={isSaving} onClick={() => fileRef.current?.click()}>
              <Upload className="mr-2 h-4 w-4" />上传头像
            </Button>
            {avatarDataUrl && <Button type="button" variant="ghost" size="sm" disabled={isSaving || isReadingAvatar} onClick={() => { setAvatarDataUrl(null); setFeedback(null); }}>移除头像</Button>}
          </div>
          <p className="text-xs text-muted-foreground">PNG、JPEG、WebP、GIF，最大 2 MB</p>
        </div>
        <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp,image/gif" className="hidden" aria-label="选择账户头像" onChange={chooseAvatar} />
      </div>
      <label className="block space-y-2 text-sm font-medium">
        <span>昵称</span>
        <input className="w-full rounded-lg border border-input bg-background px-3 py-2 outline-none focus:ring-2 focus:ring-ring" value={displayName} maxLength={64} required disabled={isSaving} onChange={(event) => { setDisplayName(event.target.value); setFeedback(null); }} />
      </label>
      <p className="text-xs text-muted-foreground">登录账户：{user.username}</p>
      {feedback && <p role={feedback.error ? 'alert' : 'status'} className={`text-sm ${feedback.error ? 'text-destructive' : 'text-green-600 dark:text-green-400'}`}>{feedback.message}</p>}
      <div className="flex items-center justify-between gap-3">
        <Button type="submit" disabled={isSaving || isReadingAvatar || !displayName.trim()}>
          {(isSaving || isReadingAvatar) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}{isReadingAvatar ? '读取头像中…' : isSaving ? '保存中…' : '保存资料'}
        </Button>
        <Button type="button" variant="ghost" disabled={isSaving} onClick={logout}><LogOut className="mr-2 h-4 w-4" />退出登录</Button>
      </div>
    </form>
  );
}
