import test from "node:test";
import assert from "node:assert/strict";
import {
  enhanceCodeBlock,
  formatCodeBlock,
  getFormatterKind,
  normalizeCodeBlockInput,
  normalizeCodeBlockLanguage,
} from "@/lib/code-block-rendering";

test("normalizeCodeBlockLanguage resolves common aliases", () => {
  assert.equal(normalizeCodeBlockLanguage("ts"), "typescript");
  assert.equal(normalizeCodeBlockLanguage("JS"), "javascript");
  assert.equal(normalizeCodeBlockLanguage("yml"), "yaml");
  assert.equal(normalizeCodeBlockLanguage("py"), "python");
  assert.equal(normalizeCodeBlockLanguage("c++"), "cpp");
  assert.equal(normalizeCodeBlockLanguage("cs"), "csharp");
  assert.equal(normalizeCodeBlockLanguage(""), "");
});

test("normalizeCodeBlockInput normalizes newlines and trims a trailing newline", () => {
  assert.deepEqual(normalizeCodeBlockInput("{\r\n\"a\":1\r\n}\r\n", "json"), {
    raw: "{\n\"a\":1\n}",
    language: "json",
  });
});

test("getFormatterKind identifies supported formatter families", () => {
  assert.equal(getFormatterKind("typescript"), "prettier");
  assert.equal(getFormatterKind("postgresql"), "sql");
  assert.equal(getFormatterKind("go"), "brace");
  assert.equal(getFormatterKind("python"), "python");
  assert.equal(getFormatterKind("bash"), "shell");
  assert.equal(getFormatterKind("java"), "brace");
  assert.equal(getFormatterKind("rust"), "brace");
  assert.equal(getFormatterKind("elixir"), "none");
});

test("formatCodeBlock formats json with prettier", async () => {
  const result = await formatCodeBlock('{"alpha":1,"beta":{"gamma":2}}', "json");

  assert.equal(result.didFormat, true);
  assert.match(result.code, /"alpha": 1/);
  assert.match(result.code, /"gamma": 2/);
});

test("formatCodeBlock formats sql with sql-formatter", async () => {
  const result = await formatCodeBlock("select id,name from users where active = 1 order by created_at desc", "sql");

  assert.equal(result.didFormat, true);
  assert.match(result.code, /^select/i);
  assert.match(result.code, /\nfrom\n\s+users/i);
  assert.match(result.code, /\nwhere\n\s+active = 1/i);
});

test("formatCodeBlock formats shell with heuristic indentation", async () => {
  const result = await formatCodeBlock('echo hi\nif [ "$A" = 1 ]; then\necho ok\nfi', "bash");

  assert.equal(result.didFormat, true);
  assert.equal(result.code, 'echo hi\nif [ "$A" = 1 ]; then\n  echo ok\nfi');
});

test("formatCodeBlock formats php with brace indentation", async () => {
  const result = await formatCodeBlock("<?php\nif($b){\necho 2;\n}", "php");

  assert.equal(result.didFormat, true);
  assert.equal(result.code, "<?php\nif($b){\n  echo 2;\n}");
});

test("formatCodeBlock formats go with brace indentation", async () => {
  const result = await formatCodeBlock('func main(){\nfmt.Println("hi")\nif ok {\nfmt.Println("ok")\n}\n}', "go");

  assert.equal(result.didFormat, true);
  assert.equal(result.code, 'func main(){\n  fmt.Println("hi")\n  if ok {\n    fmt.Println("ok")\n  }\n}');
});

test("formatCodeBlock formats python with heuristic indentation", async () => {
  const result = await formatCodeBlock('def hello(name):\nprint(f"hi {name}")\nif ready:\nprint("ok")', "python");

  assert.equal(result.didFormat, true);
  assert.equal(result.code, 'def hello(name):\n    print(f"hi {name}")\n    if ready:\n        print("ok")');
});

test("formatCodeBlock formats java with brace indentation", async () => {
  const result = await formatCodeBlock("class Test{\npublic static void main(String[] args){\nSystem.out.println(1);\n}\n}", "java");

  assert.equal(result.didFormat, true);
  assert.equal(result.code, "class Test{\n  public static void main(String[] args){\n    System.out.println(1);\n  }\n}");
});

test("formatCodeBlock formats csharp with brace indentation", async () => {
  const result = await formatCodeBlock("class Test{\nstatic void Main(){\nSystem.Console.WriteLine(1);\n}\n}", "csharp");

  assert.equal(result.didFormat, true);
  assert.equal(result.code, "class Test{\n  static void Main(){\n    System.Console.WriteLine(1);\n  }\n}");
});

test("formatCodeBlock formats cpp with brace indentation", async () => {
  const result = await formatCodeBlock("int main(){\nstd::cout<<1;\nif (ok) {\nstd::cout<<2;\n}\n}", "cpp");

  assert.equal(result.didFormat, true);
  assert.equal(result.code, "int main(){\n  std::cout<<1;\n  if (ok) {\n    std::cout<<2;\n  }\n}");
});

test("formatCodeBlock formats rust with brace indentation", async () => {
  const raw = 'fn main(){\nprintln!("hi");\nif true {\nprintln!("ok");\n}\n}';
  const result = await formatCodeBlock(raw, "rust");

  assert.equal(result.didFormat, true);
  assert.equal(result.code, 'fn main(){\n  println!("hi");\n  if true {\n    println!("ok");\n  }\n}');
});

test("formatCodeBlock falls back to raw code when formatting fails", async () => {
  const raw = '{"alpha": }';
  const result = await formatCodeBlock(raw, "json");

  assert.equal(result.didFormat, false);
  assert.equal(result.didFallback, true);
  assert.equal(result.code, raw);
});

test("enhanceCodeBlock keeps streaming content unformatted until stable", async () => {
  const raw = '{"alpha":1}';
  const liveResult = await enhanceCodeBlock({ raw, language: "json", stable: false });
  const stableResult = await enhanceCodeBlock({ raw, language: "json", stable: true });

  assert.equal(liveResult.displayCode, raw);
  assert.equal(liveResult.didFormat, false);
  assert.notEqual(stableResult.displayCode, raw);
  assert.equal(stableResult.copyCode, stableResult.displayCode);
});

test("enhanceCodeBlock keeps unsupported languages as highlighted raw text", async () => {
  const raw = "puts :hello";
  const result = await enhanceCodeBlock({ raw, language: "ruby", stable: true });

  assert.equal(result.displayCode, raw);
  assert.equal(result.didFormat, false);
  assert.equal(result.didFallback, true);
  assert.equal(result.highlighterLanguage, "ruby");
});
