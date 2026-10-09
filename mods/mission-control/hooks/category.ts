// What a file is for, from its path alone: the code map frames files of one kind together.

export const CATEGORIES = ['Source', 'Tests', 'API & contracts', 'Database', 'Translations', 'Config & env', 'Dependencies', 'CI & infra', 'Docs', 'Styles'] as const
export type Category = (typeof CATEGORIES)[number]

// The first rule that matches wins, so a spec file under `locales/` is a test and `db/migrate/x.rb` is Database, not Source.
const RULES: [Exclude<Category, 'Source'>, RegExp[]][] = [
  ['Tests', [/(^|\/)(__tests__|__mocks__|__snapshots__|tests?|specs?|e2e|cypress|fixtures)\//i, /\.(test|spec)\.[a-z]+$/i, /_test\.(go|py|rb|exs?)$/i, /(^|\/)test_[^/]+\.py$/i, /_spec\.rb$/i, /(Test|Tests|Spec)\.(java|kt|swift|cs)$/]],
  ['Translations', [/(^|\/)(locales?|i18n|translations?|lang|languages|l10n)\//i, /\.(po|pot|xlf|xliff)$/i, /(^|\/)messages[._-][\w-]+\.json$/i, /(^|\/)(en|fr|de|es|it|pt|nl)(-[a-z]{2})?\.(json|ya?ml)$/i]],
  ['Database', [/(^|\/)(migrations?|migrate)\//i, /(^|\/)db\/(migrate|seeds?)\//i, /\.sql$/i, /(^|\/)(schema\.rb|structure\.sql)$/i, /(^|\/)prisma\//i]],
  ['API & contracts', [/\.d\.ts$/i, /\.(proto|graphql|gql)$/i, /(^|\/)(openapi|swagger)[^/]*\.(json|ya?ml)$/i]],
  ['CI & infra', [/(^|\/)\.github\//i, /(^|\/)\.gitlab-ci\.ya?ml$/i, /(^|\/)Jenkinsfile$/, /(^|\/)Dockerfile[^/]*$/i, /(^|\/)docker-compose[^/]*\.ya?ml$/i, /(^|\/)(terraform|k8s|kubernetes|helm|\.circleci|infra|deploy)\//i, /\.tf$/i]],
  ['Dependencies', [/(^|\/)(package\.json|package-lock\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|Gemfile(\.lock)?|go\.(mod|sum)|requirements[^/]*\.txt|pyproject\.toml|poetry\.lock|pom\.xml|build\.gradle(\.kts)?|Cargo\.(toml|lock)|composer\.(json|lock))$/i]],
  ['Config & env', [/(^|\/)\.env[^/]*$/i, /\.config\.[a-z]+$/i, /(^|\/)(tsconfig[^/]*\.json|\.eslintrc[^/]*|\.prettierrc[^/]*|\.babelrc|\.editorconfig)$/i, /\.(ya?ml|toml|ini|properties|json)$/i, /(^|\/)config\//i]],
  ['Docs', [/\.(md|mdx)$/i, /(^|\/)docs?\//i]],
  ['Styles', [/\.(css|scss|sass|less)$/i]],
]

export function categoryOf(path: string): Category {
  for (const [name, patterns] of RULES) if (patterns.some(p => p.test(path))) return name
  return 'Source'
}
