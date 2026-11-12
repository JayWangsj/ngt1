import { PageHeader } from "@/components/common";
import { SettingsOverview } from "@/components/settings";
import { getMessages } from "@/lib/i18n-server";
import { isTestToolsEnabled } from "@/lib/test-tools-guard";

export default async function SettingsPage() {
  const it = await getMessages();
  return (
    <>
      <PageHeader
        title={it.nav.settings}
        description={it.settingsDescription}
      />
      <SettingsOverview testToolsEnabled={isTestToolsEnabled()} />
    </>
  );
}
