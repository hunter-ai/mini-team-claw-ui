import type { Dictionary } from "@/lib/i18n/dictionary";

export type AdminNavItem = {
  key: "members" | "backups" | "workspace";
  href: string;
  label: string;
  description: string;
};

export type AdminNavSection = {
  key: "operations" | "data" | "workspace";
  label: string;
  items: AdminNavItem[];
};

export function getAdminNavigation(messages: Dictionary): AdminNavSection[] {
  return [
    {
      key: "operations",
      label: messages.admin.groupOperations,
      items: [
        {
          key: "members",
          href: "/admin/members",
          label: messages.admin.membersNavLabel,
          description: messages.admin.membersNavDescription,
        },
      ],
    },
    {
      key: "data",
      label: messages.admin.groupData,
      items: [
        {
          key: "backups",
          href: "/admin/backups",
          label: messages.admin.backupsNavLabel,
          description: messages.admin.backupsNavDescription,
        },
      ],
    },
    {
      key: "workspace",
      label: messages.admin.groupWorkspace,
      items: [
        {
          key: "workspace",
          href: "/admin/workspace",
          label: messages.admin.workspaceNavLabel,
          description: messages.admin.workspaceNavDescription,
        },
      ],
    },
  ];
}
