type FormatterKind = "prettier" | "sql" | "python" | "shell" | "brace" | "none";
type SupportedSqlLanguage = "sql" | "postgresql" | "mysql" | "sqlite";
type PrettierPluginList = NonNullable<
  NonNullable<Parameters<(typeof import("prettier/standalone"))["format"]>[1]>["plugins"]
>;

export type CodeEnhancementResult = {
  displayCode: string;
  copyCode: string;
  language: string;
  highlighterLanguage: string | null;
  didFormat: boolean;
  didFallback: boolean;
};

type CodeEnhancementInput = {
  raw: string;
  language: string;
  stable: boolean;
};

type PrettierFormatConfig = {
  parser: string;
  plugins: Promise<PrettierPluginList>;
};

const LANGUAGE_ALIASES: Record<string, string> = {
  bash: "bash",
  c: "c",
  "c#": "csharp",
  "c++": "cpp",
  cc: "cpp",
  cjs: "javascript",
  cpp: "cpp",
  cs: "csharp",
  csharp: "csharp",
  css: "css",
  go: "go",
  golang: "go",
  gql: "graphql",
  graphql: "graphql",
  hpp: "cpp",
  htm: "html",
  html: "html",
  hxx: "cpp",
  java: "java",
  javascript: "javascript",
  js: "javascript",
  json: "json",
  json5: "json",
  jsonc: "json",
  jsx: "jsx",
  less: "less",
  markdown: "markdown",
  md: "markdown",
  mdx: "mdx",
  mysql: "mysql",
  php: "php",
  postgres: "postgresql",
  postgresql: "postgresql",
  psql: "postgresql",
  py: "python",
  python: "python",
  rs: "rust",
  rust: "rust",
  sass: "scss",
  scss: "scss",
  shell: "bash",
  shellscript: "bash",
  sh: "bash",
  sql: "sql",
  sqlite: "sqlite",
  sqlite3: "sqlite",
  text: "text",
  ts: "typescript",
  tsx: "tsx",
  typescript: "typescript",
  yaml: "yaml",
  yml: "yaml",
  zsh: "bash",
};

const PRETTIER_FORMATTERS = new Map<string, PrettierFormatConfig>([
  ["javascript", { parser: "babel", plugins: Promise.all([import("prettier/plugins/babel"), import("prettier/plugins/estree")]) }],
  ["jsx", { parser: "babel", plugins: Promise.all([import("prettier/plugins/babel"), import("prettier/plugins/estree")]) }],
  ["typescript", { parser: "typescript", plugins: Promise.all([import("prettier/plugins/typescript"), import("prettier/plugins/estree")]) }],
  ["tsx", { parser: "typescript", plugins: Promise.all([import("prettier/plugins/typescript"), import("prettier/plugins/estree")]) }],
  ["json", { parser: "json", plugins: Promise.all([import("prettier/plugins/babel"), import("prettier/plugins/estree")]) }],
  ["html", { parser: "html", plugins: Promise.all([import("prettier/plugins/html")]) }],
  ["css", { parser: "css", plugins: Promise.all([import("prettier/plugins/postcss")]) }],
  ["scss", { parser: "scss", plugins: Promise.all([import("prettier/plugins/postcss")]) }],
  ["less", { parser: "less", plugins: Promise.all([import("prettier/plugins/postcss")]) }],
  ["yaml", { parser: "yaml", plugins: Promise.all([import("prettier/plugins/yaml")]) }],
  ["markdown", { parser: "markdown", plugins: Promise.all([import("prettier/plugins/markdown")]) }],
  ["mdx", { parser: "mdx", plugins: Promise.all([import("prettier/plugins/markdown")]) }],
  ["graphql", { parser: "graphql", plugins: Promise.all([import("prettier/plugins/graphql")]) }],
]);

const SQL_DIALECTS = new Set<SupportedSqlLanguage>(["sql", "mysql", "postgresql", "sqlite"]);
const BRACE_LANGUAGES = new Set(["go", "rust", "java", "c", "cpp", "csharp", "php"]);
const enhancementCache = new Map<string, Promise<CodeEnhancementResult>>();

export function normalizeCodeBlockLanguage(language: string) {
  const normalized = language.trim().toLowerCase();
  if (!normalized) {
    return "";
  }

  return LANGUAGE_ALIASES[normalized] ?? normalized;
}

export function normalizeCodeBlockInput(raw: string, language: string) {
  return {
    raw: raw.replace(/\r\n?/g, "\n").replace(/\n$/, ""),
    language: normalizeCodeBlockLanguage(language),
  };
}

export function getFormatterKind(language: string): FormatterKind {
  if (PRETTIER_FORMATTERS.has(language)) {
    return "prettier";
  }

  if (SQL_DIALECTS.has(language as SupportedSqlLanguage)) {
    return "sql";
  }

  if (language === "python") {
    return "python";
  }

  if (language === "bash") {
    return "shell";
  }

  if (BRACE_LANGUAGES.has(language)) {
    return "brace";
  }

  return "none";
}

export function getHighlighterLanguage(language: string) {
  if (!language || language === "text") {
    return null;
  }

  if (language === "postgresql" || language === "mysql" || language === "sqlite") {
    return "sql";
  }

  if (language === "mdx") {
    return "markdown";
  }

  return language;
}

function countBraceDelta(line: string) {
  let delta = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let inBacktick = false;
  let escapeNext = false;

  for (const character of line) {
    if (escapeNext) {
      escapeNext = false;
      continue;
    }

    if (character === "\\") {
      escapeNext = true;
      continue;
    }

    if (character === "'" && !inDoubleQuote && !inBacktick) {
      inSingleQuote = !inSingleQuote;
      continue;
    }

    if (character === '"' && !inSingleQuote && !inBacktick) {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }

    if (character === "`" && !inSingleQuote && !inDoubleQuote) {
      inBacktick = !inBacktick;
      continue;
    }

    if (inSingleQuote || inDoubleQuote || inBacktick) {
      continue;
    }

    if (character === "{") {
      delta += 1;
    } else if (character === "}") {
      delta -= 1;
    }
  }

  return delta;
}

function formatBraceLanguage(raw: string) {
  const lines = raw.replace(/\t/g, "  ").split("\n");
  let indentLevel = 0;

  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return "";
      }

      if (/^[}\])]/.test(trimmed) || /^(case\s.+:|default:)/.test(trimmed)) {
        indentLevel = Math.max(indentLevel - 1, 0);
      }

      const nextLine = `${"  ".repeat(indentLevel)}${trimmed}`;
      indentLevel = Math.max(indentLevel + countBraceDelta(trimmed), 0);

      if (/^(case\s.+:|default:)/.test(trimmed) && !trimmed.includes("{")) {
        indentLevel += 1;
      }

      return nextLine;
    })
    .join("\n");
}

function formatPython(raw: string) {
  const lines = raw.replace(/\t/g, "    ").split("\n");
  let indentLevel = 0;

  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return "";
      }

      if (/^(elif\b.*:|else:|except\b.*:|finally:|case\s.+:)/.test(trimmed)) {
        indentLevel = Math.max(indentLevel - 1, 0);
      }

      const nextLine = `${" ".repeat(indentLevel * 4)}${trimmed}`;

      if (trimmed.endsWith(":") && !trimmed.startsWith("#")) {
        indentLevel += 1;
      }

      return nextLine;
    })
    .join("\n");
}

function formatShell(raw: string) {
  const lines = raw.replace(/\t/g, "  ").split("\n");
  let indentLevel = 0;

  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) {
        return "";
      }

      if (/^(fi|done|esac|\}|elif\b|else\b)/.test(trimmed)) {
        indentLevel = Math.max(indentLevel - 1, 0);
      }

      const nextLine = `${"  ".repeat(indentLevel)}${trimmed}`;

      if (
        /(^if\b.*(?:;)?\s*then$)|(^then$)|(^for\b.*(?:;)?\s*do$)|(^while\b.*(?:;)?\s*do$)|(^until\b.*(?:;)?\s*do$)|(^select\b.*(?:;)?\s*do$)|(^do$)|(^case\b.*\sin$)|(\{$)/.test(trimmed)
      ) {
        indentLevel += 1;
      }

      if (/^(elif\b|else\b)/.test(trimmed)) {
        indentLevel += 1;
      }

      return nextLine;
    })
    .join("\n");
}

function applyHeuristicFormatting(raw: string, language: string) {
  if (language === "python") {
    return formatPython(raw);
  }

  if (language === "bash") {
    return formatShell(raw);
  }

  return formatBraceLanguage(raw);
}

export async function formatCodeBlock(raw: string, language: string) {
  const formatterKind = getFormatterKind(language);

  if (formatterKind === "none") {
    return { code: raw, didFormat: false, didFallback: true };
  }

  try {
    if (formatterKind === "sql") {
      const [{ format }] = await Promise.all([import("sql-formatter")]);
      const sqlLanguage: SupportedSqlLanguage =
        language === "postgresql" || language === "mysql" || language === "sqlite" ? language : "sql";
      return { code: format(raw, { language: sqlLanguage }), didFormat: true, didFallback: false };
    }

    if (formatterKind === "python" || formatterKind === "shell" || formatterKind === "brace") {
      const formatted = applyHeuristicFormatting(raw, language);
      return {
        code: formatted,
        didFormat: formatted !== raw,
        didFallback: false,
      };
    }

    const [{ format }, config] = await Promise.all([
      import("prettier/standalone"),
      PRETTIER_FORMATTERS.get(language)!,
    ]);
    const plugins = await config.plugins;
    const formatted = await format(raw, {
      parser: config.parser,
      plugins,
      printWidth: 100,
      tabWidth: 2,
      useTabs: false,
      singleQuote: false,
      trailingComma: "es5",
      proseWrap: "preserve",
    });

    return { code: formatted.replace(/\n$/, ""), didFormat: true, didFallback: false };
  } catch {
    const fallback = applyHeuristicFormatting(raw, language);
    return {
      code: fallback,
      didFormat: fallback !== raw,
      didFallback: true,
    };
  }
}

export async function enhanceCodeBlock(input: CodeEnhancementInput): Promise<CodeEnhancementResult> {
  const normalized = normalizeCodeBlockInput(input.raw, input.language);
  const cacheKey = `${input.stable ? "stable" : "live"}:${normalized.language}:${normalized.raw}`;
  const cached = enhancementCache.get(cacheKey);
  if (cached) {
    return cached;
  }

  const task = (async () => {
    if (!normalized.raw) {
      return {
        displayCode: "",
        copyCode: "",
        language: normalized.language,
        highlighterLanguage: getHighlighterLanguage(normalized.language),
        didFormat: false,
        didFallback: false,
      } satisfies CodeEnhancementResult;
    }

    if (!input.stable) {
      return {
        displayCode: normalized.raw,
        copyCode: normalized.raw,
        language: normalized.language,
        highlighterLanguage: getHighlighterLanguage(normalized.language),
        didFormat: false,
        didFallback: false,
      } satisfies CodeEnhancementResult;
    }

    const formatted = await formatCodeBlock(normalized.raw, normalized.language);

    return {
      displayCode: formatted.code,
      copyCode: formatted.code,
      language: normalized.language,
      highlighterLanguage: getHighlighterLanguage(normalized.language),
      didFormat: formatted.didFormat,
      didFallback: formatted.didFallback,
    } satisfies CodeEnhancementResult;
  })();

  enhancementCache.set(cacheKey, task);
  return task;
}
