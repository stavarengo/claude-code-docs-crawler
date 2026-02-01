# Commit message generation instructions

- Tone: technical, direct to the point, easy for quick scan reading.
- Use Conventional Commits:

  ```
  <type>[optional scope]: <description>

  [optional body]

  [optional footer(s)]
  ```

- For `<type>`, use:
  - `fix`: Bug fix (PATCH release).
  - `feat`: New feature (MINOR release).
  - `BREAKING CHANGE`: Major breaking changes, indicated by a `!` after type/scope (MAJOR release).
    - Requires you to add a footer like `BREAKING CHANGE: <description>` following Git trailer conventions.
  - Other valid types include: `build`, `chore`, `ci`, `docs`, `style`, `refactor`, `perf`, `test`.

- The `<scope>` is optional. Only use if:
  - we have a scope of change in the commit is unambiguous, and
  - if the value it adds is significantly more useful than the added length and noise it creates.
  - Dont use if unsure.

- For <description>:
  - Use imperative mood, e.g., "add feature" not "added feature".
  - Keep it concise (max 7 words excluding articles like "the", "to").
    - Aim for using as few words as possible while still being clear (less is better).
  - Aim for a description that capture the root purpose of the change (the change essence). In another words, the what this commit contains. Examples:
    - Use `feat: update agents docs` instead of `feat: update .gitignore and documentation for commit message guidelines`

- For body and footer:
  - Avoid it as much as possible; keep commit messages short and focused.
  - Only use if required or absolutely necessary for context.
