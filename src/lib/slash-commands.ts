export type SlashCommandDefinition = {
  key: string;
  label: string;
  description: string;
  aliases: string[];
  argumentHint?: string;
  insertText: string;
};

export const OPENCLAW_SLASH_COMMANDS: SlashCommandDefinition[] = [
  {
    key: "help",
    label: "/help",
    description: "Show the available OpenClaw commands.",
    aliases: ["commands-help"],
    insertText: "/help ",
  },
  {
    key: "commands",
    label: "/commands",
    description: "List all supported slash commands.",
    aliases: ["command-list"],
    insertText: "/commands ",
  },
  {
    key: "status",
    label: "/status",
    description: "Show current status and provider usage information.",
    aliases: ["state"],
    insertText: "/status ",
  },
  {
    key: "whoami",
    label: "/whoami",
    description: "Show the current sender identity.",
    aliases: ["id"],
    argumentHint: "/whoami",
    insertText: "/whoami ",
  },
  {
    key: "context",
    label: "/context",
    description: "Inspect the current context, detail, or JSON view.",
    aliases: ["ctx"],
    argumentHint: "/context [list|detail|json]",
    insertText: "/context ",
  },
  {
    key: "session",
    label: "/session",
    description: "Manage session-level behavior such as idle or max-age.",
    aliases: ["sess"],
    argumentHint: "/session idle <duration|off>",
    insertText: "/session ",
  },
  {
    key: "model",
    label: "/model",
    description: "Switch to a different model or provider/model target.",
    aliases: ["use-model"],
    argumentHint: "/model <provider/model>",
    insertText: "/model ",
  },
  {
    key: "compact",
    label: "/compact",
    description: "Compact the current conversation, optionally with instructions.",
    aliases: ["summarize-session"],
    argumentHint: "/compact [instructions]",
    insertText: "/compact ",
  },
];
