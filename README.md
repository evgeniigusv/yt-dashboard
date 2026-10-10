# YouTube-пульт

Дашборд по всем YouTube-каналам: цифры, воронки, монетизация, календарь выпусков.
Работает в облаке: GitHub Actions каждые 3 часа забирает данные из YouTube API, шифрует их и выкладывает
на GitHub Pages. Открыть можно с любого устройства, пароль вводится один раз.

- `site/` — сам дашборд (статический сайт: `index.html`, `app.js`, `style.css`). Демо с выдуманными цифрами — `?demo`.
- `collector/collect.py` — сборщик (YouTube Data API v3 + Analytics API + Reporting API).
- `collector/auth.py` — подключение канала (один раз на канал, на Маке).
- `channels.json` — список каналов. Добавить канал = строка здесь + `auth.py add`.
- Данные живут в ветке `data` (одна перезаписываемая фиксация, история не растёт), зашифрованы
  AES-256-GCM, ключ из пароля `DASH_PASSWORD` (PBKDF2, 250 тыс. итераций). Код публичный, цифры — нет.

## Что показывает

| Раздел | Что | Откуда |
|---|---|---|
| Обзор | подписчики (±), просмотры, engaged-просмотры, часы, показы и CTR превью, среднее время, доход + RPM, сравнение с прошлым периодом | Analytics API, Reporting API |
| Воронки | ролики: показ→клик→0:30→% просмотра→лайк/комментарий/подписка; Shorts: смотрят/листают→% просмотра→лайк→подписка; светофор по нормам из `research/benchmarks-dashboard.md` | Analytics API |
| Ролики | таблица всех роликов и Shorts: 48 ч / 7 дней, CTR, удержание на 0:30, % просмотра, подписки на просмотр, доход; карточка ролика с кривой удержания, источниками трафика и CTR по источникам | Analytics + Reporting API |
| Календарь | месяц + список: вышло / в расписании / готово / в работе / в плане, рубрики (буквы структуры A–F), Shorts привязаны к ролику | YouTube (вышедшее и запланированное) + `calendar.json` конвейера |
| Аудитория | источники трафика (всё / ролики / Shorts), подписчики vs новые, устройства (ТВ!), страны, возраст и пол | Analytics API |
| Монетизация | прогресс к YPP по правилам до и после 01.02.2027 и раннему уровню, прогноз даты по темпу; доход, RPM, CPM, доход по роликам | Analytics API (доход — после включения монетизации) |
| Затраты | план и факт по каждому ролику: кредиты Higgsfield по шагам (озвучка, картинки…), минуты работы, токены Claude по шагам (создание, публикация, правки), кредиты на 1000 просмотров; баланс Higgsfield и на сколько роликов хватит | `costs.json` конвейера (`tools/costs.py`) |
| Улучшения | советник (`collector/advisor.py`, одни правила на все каналы): «сделать сейчас» (эффект сразу, только запросы), западающие зоны с причинами и выходом, «исправлено — ждём проверки» (эксперименты из `docs/IMPROVEMENTS.md` каждого конвейера), риски; то же уходит в Telegram раз в день (`tools/dashboard.py telegram` в конвейере) | данные дашборда + репозитории конвейеров |
| Сводка (все каналы) | хозяйство: каналы и монетизация, заработано, расходы в месяц и окупаемость (цены — `economics` в channels.json), баланс Higgsfield и запас роликов, лимит Claude, выпуск по плану; производство по статусам; экономика каналов; таблица каналов, выбросы, тревоги, ближайшие выходы | всё выше |

Тревоги: низкий CTR в первую неделю, провал удержания на 0:30, Shorts пролистывают, выброс — делать продолжение,
высокий отток подписчиков, пустое расписание на 7 дней, устаревшие данные / ошибки сбора.

Чего нет в API и не будет в дашборде: уникальные и возвращающиеся зрители, точное «смотрят vs пролистали» у Shorts
(показана близкая метрика — доля engaged-просмотров), результаты «Теста и сравнения» превью.

## Подключение (один раз)

1. **Google Cloud** (console.cloud.google.com): новый проект → включить *YouTube Data API v3*, *YouTube Analytics API*,
   *YouTube Reporting API* → Google Auth Platform: тип External, своя почта → **Audience → Publish app**
   (иначе токены умирают через 7 дней; проверка Google не нужна — при входе будет предупреждение «приложение
   не проверено», это нормально для личного использования) → Clients → Create client → **Desktop app** → скачать JSON.
2. На Маке:
   ```bash
   cd ~/code/yt-dashboard && .venv/bin/python collector/auth.py client ~/Downloads/client_secret_*.json
   .venv/bin/python collector/auth.py add      # выбрать аккаунт канала → «Разрешить»
   gh secret set DASH_PASSWORD -R evgeniigusv/yt-dashboard   # придумать пароль дашборда (от 8 символов)
   ```
3. Запустить сбор сразу: `gh workflow run collect -R evgeniigusv/yt-dashboard` (дальше — сам каждые 3 часа).

Права только на чтение: дашборд ничего не может изменить, загрузить или удалить на канале.

## Новый канал

1. Строка в `channels.json` (`slug`, `name`, `channel_id`, при желании `calendar` — репозиторий его конвейера).
2. `auth.py add` под аккаунтом этого канала.
3. Для календаря: deploy key только на чтение к репозиторию конвейера
   (`ssh-keygen -t ed25519 -f key`, `gh repo deploy-key add key.pub -R <repo>`, `gh secret set DEPLOY_KEY_<SLUG> < key`)
   и строка `DEPLOY_KEY_<SLUG>` в `.github/workflows/collect.yml`. Конвейер должен класть `calendar.json`
   (формат — ниже) в ветку из `branches`.

## Формат calendar.json (контракт с конвейером)

```json
{
  "updated": "2026-10-04T09:00:00+00:00",
  "rubrics": {"A": {"name": "Всё о типах"}, "B": {"name": "Обратный отсчёт"}},
  "items": [
    {"id": "2026-10-02_sagittarius-a-star", "format": "long", "title": "…", "alt_titles": ["…"],
     "rubric": "C", "status": "published", "date": "2026-10-02", "youtube_id": "zlezbsXTzZk"},
    {"id": "2026-10-02_sagittarius-a-star-s02", "format": "short", "parent": "2026-10-02_sagittarius-a-star",
     "title": "…", "status": "scheduled", "date": "2026-10-04T18:00:00-04:00"},
    {"id": "topic-04", "format": "long", "title": "10 Strangest Planets Ever Discovered", "rubric": "B",
     "status": "planned", "date": "2026-10-08"}
  ]
}
```

`status`: `idea` · `planned` · `in_production` · `ready` (готово, ждёт «Ок») · `scheduled` · `published` · `failed`.
`date` — ISO со смещением или только дата. Что YouTube знает сам (вышло, стоит в расписании), берётся из YouTube.
У Chalkonaut файл строит `tools/release_calendar.py --push` в репозитории конвейера.

## Локально

```bash
.venv/bin/python collector/demo.py          # демо-данные в site/demo (пароль demo)
python3 -m http.server 8765 -d site         # http://localhost:8765/?demo
```
