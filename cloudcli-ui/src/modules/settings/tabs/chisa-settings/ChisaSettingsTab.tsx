import SettingsSection from '@/modules/settings/SettingsSection';
import { AccountServerConnection } from '@/modules/auth';
import { isDesktop } from '@/shared/chisa';
import { SshConnectionSettings } from '@/modules/ssh-workspaces';

/** Settings uses this desktop-only tab to configure the cloud account service. */
export default function ChisaSettingsTab() {
  if (!isDesktop()) {
    return (
      <SettingsSection title="账号服务" description="此页面仅在 ChisaCloudCode 桌面应用中可用。">
        <div className="text-sm text-muted-foreground">未检测到桌面环境。</div>
        <SshConnectionSettings />
      </SettingsSection>
    );
  }

  return (
    <SettingsSection title="账号服务" description="连接云端服务器以使用项目、文件、Git、终端和 AI 会话。">
      <AccountServerConnection />
      <SshConnectionSettings />
    </SettingsSection>
  );
}
