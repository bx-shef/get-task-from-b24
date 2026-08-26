# Чек-лист настройки репозитория (владелец)

> Last reviewed: 2026-08-26

Что владелец репозитория (admin) делает в **Settings** один раз, чтобы заработало
правило «в `main` не пушим — только через PR с зелёным CI». Файлы CI
(`.github/workflows/ci.yml`) и Dependabot (`.github/dependabot.yml`) уже в репозитории;
здесь — настройки, которые **нельзя** задать файлом.

## 1. Защита `main` (ruleset `protect-main`)

**Settings → Rules → Rulesets → New branch ruleset.**

| Поле | Значение |
|---|---|
| **Ruleset Name** | `protect-main` |
| **Enforcement status** | `Active` |
| **Bypass list** | пусто |
| **Target branches** | Add target → **Include default branch** (`main`) |

В секции **Rules** включить:

- [ ] **Restrict deletions** — нельзя удалить `main`.
- [ ] **Block force pushes** — нельзя переписать историю.
- [ ] **Require a pull request before merging**
  - **Required approvals:** `0` (или `1`, если разработчиков больше одного)
  - [ ] **Dismiss stale pull request approvals when new commits are pushed**
  - [ ] **Require conversation resolution before merging**
- [ ] **Require status checks to pass**
  - [ ] **Require branches to be up to date before merging**
  - **Add checks:** ввести `ci` и выбрать из автодополнения.

> Если `ci` не появляется в списке — workflow ещё ни разу не отрабатывал. Откройте
> первый PR, `ci` запустится, затем вернитесь и добавьте check. Имя должно **точно**
> совпадать с именем джобы `ci` в `ci.yml`.

**Проверка** — обе команды должны отклониться, прямой push в `main` тоже:

```bash
git push origin main --force
git push origin :main
```

## 2. Автоудаление веток после мержа

**Settings → General → Pull Requests** → ☑ **Automatically delete head branches**.

## 3. Squash-merge как единственный способ

**Settings → General → Pull Requests**: оставить ☑ **Allow squash merging**, снять
**Allow merge commits** и **Allow rebase merging**. История `main` — один коммит на PR.

## 4. Dependabot

**Settings → Code security and analysis** → включить:

- [ ] **Dependabot alerts**
- [ ] **Dependabot security updates**
- [ ] **Dependabot version updates** (использует `.github/dependabot.yml`)

Чтобы Dependabot мог открывать PR: **Settings → Actions → General → Workflow
permissions** → ☑ **Allow GitHub Actions to create and approve pull requests**.

> ⚠ У `node` в `dependabot.yml` мажорные обновления в `ignore`: из образов node:25+
> убран corepack (`RUN corepack enable` → exit 127). У `typescript` — по той же
> причине: `typescript-eslint` не работает с TS 7, и на нём линт не запускается вовсе.

## 5. Проверка

Жизненный цикл изменения после настройки:

1. `git checkout -b feature/x` → коммит → push.
2. PR в `main` → автоматически стартует `ci`.
3. Красный CI → чините и пушите ещё раз.
4. `main` ушёл вперёд → кнопка **Update branch**.
5. Панель из 5 проверяющих ([`PROCESS.md`](PROCESS.md)) → замечания устранены → **Squash and merge**.

Прямой push в `main`, force-push и удаление ветки на этом этапе уже невозможны.
