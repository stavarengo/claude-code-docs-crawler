import { includeIgnoreFile } from "@eslint/compat"
import eslint from "@eslint/js"
import json from "@eslint/json"
import markdown from "@eslint/markdown"
import stylistic from "@stylistic/eslint-plugin"
import { defineConfig, globalIgnores } from "eslint/config"
import path from "node:path"
import { globSync } from "tinyglobby"
import tseslint from "typescript-eslint"

const forceJsonAsJsoncFiles = ["**/tsconfig.*json", "**/.devcontainer/devcontainer.json"]

const markdownBase = {
  name: "Markdown Files",
  files: ["**/*.md"],
  plugins: { markdown },
  language: "markdown/gfm",
  extends: ["markdown/recommended"],
  rules: {},
}

export default defineConfig([
  globalIgnores([".idea/**", ".vscode/**", "**/*.d.ts", "content/**", ".devcontainer/**"], "Global Ignores"),
  ...globSync("**/.gitignore", { ignore: ["node_modules/**"], absolute: true }).map((rootGitIgnoreFile) => {
    return includeIgnoreFile(rootGitIgnoreFile, `'Global Ignores from ${path.relative(__dirname, rootGitIgnoreFile)}'`)
  }),

  {
    name: "General TS/JS Linting Rules",
    files: ["**/*.{ts,tsx,js}"],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      eslint,
      tseslint,
      "@stylistic": stylistic,
    },
    extends: [
      eslint.configs.recommended,
      tseslint.configs.stylisticTypeChecked,
      stylistic.configs.customize({
        indent: 2,
        quotes: "double",
        semi: false,
        jsx: true,
        braceStyle: "1tbs",
        blockSpacing: true,
        quoteProps: "as-needed",
        experimental: true,
      }),
    ],
    rules: {
      "@typescript-eslint/prefer-nullish-coalescing": [
        "error",
        {
          ignorePrimitives: {
            string: true,
          },
        },
      ],
      "@stylistic/arrow-parens": [
        "error",
        "as-needed",
        {
          requireForBlockBody: true,
        },
      ],
      "@stylistic/comma-dangle": [
        "error",
        {
          arrays: "always-multiline",
          objects: "always-multiline",
          imports: "always-multiline",
          exports: "always-multiline",
          functions: "always-multiline",
          importAttributes: "always-multiline",
          dynamicImports: "always-multiline",
          enums: "always-multiline",
          generics: "always-multiline",
          tuples: "always-multiline",
        },
      ],

    },
  },
  {
    name: "React JSX (JavaScript XML) Specific Linting Rules",
    settings: {
      react: { version: "detect" },
    },
    files: ["**/*.{tsx}"],
    plugins: {
      pluginReact,
    },
    extends: [pluginReact.configs.flat["recommended"]!, pluginReact.configs.flat["jsx-runtime"]!],
  },
  {
    name: "JSON Files",
    files: ["**/*.json"],
    ignores: ["package-lock.json", ...forceJsonAsJsoncFiles],
    plugins: { json },
    language: "json/json",
    extends: ["json/recommended"],
    rules: {
      "json/sort-keys": ["off", "asc", { natural: true, allowLineSeparatedGroups: true }],
    },
  },

  {
    name: "JSONC Files",
    files: ["**/*.jsonc", ...forceJsonAsJsoncFiles],
    plugins: { json },
    language: "json/jsonc",
    extends: ["json/recommended"],
  },

  {
    name: "JSON5 Files",
    files: ["**/*.json5"],
    plugins: { json },
    language: "json/json5",
    extends: ["json/recommended"],
  },

  markdownBase,
  {
    ...markdownBase,
    name: markdownBase.name + "(AI instructions docs)",
    files: [".claude/**/*.md", "docs/ai/**/*.md"],
    rules: {
      ...markdownBase.rules,
      "markdown/fenced-code-language": "off",
      "markdown/no-missing-label-refs": "off",
    },
  },
])
