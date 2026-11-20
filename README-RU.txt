CS2 MARKET — локальный проект

Что сохраняется
- Backend использует SQLite для аккаунтов, балансов, инвентарей, транзакций, игр, Multiplayer, административных действий и Telegram Stars.
- После настройки GitHub backend загружает в отдельный private repository сжатую полную копию SQLite (`backups/cs2-market.sqlite.gz`), читаемый журнал (`backups/log.txt`) и сводку (`backups/stats.json`).
- При старте backend восстанавливает SQLite из приватного GitHub repository до открытия базы. База и журнал обновляются при изменении данных, статистика — раз в 5 минут.
- Для обновления резервной ветки backend публикует свежий корневой снимок и перемещает указатель branch; в истории ветки остаётся последнее состояние, не накапливая цепочку коммитов каждые 5 минут.
- Интерфейс Reface V2 светлый и адаптирован для телефонов; upgrader показывает шанс и серверный результат без вращения.

Настройка GitHub-бэкапа
1. На GitHub создай отдельный repository `cs2-market-backups`, поставь **Private** и включи **Add a README file**, чтобы появилась ветка `main`. Не используй репозиторий сайта: в нём лежат личные данные игроков.
2. Создай Fine-grained personal access token: GitHub → Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token.
3. Ограничь токен только repository `cs2-market-backups`. В Repository permissions дай `Contents: Read and write`; Metadata оставь в стандартном режиме Read.
4. В Render → сервис → Environment добавь:
   `GITHUB_BACKUP_REPO=ТВОЙ-ЛОГИН/cs2-market-backups`
   `GITHUB_BACKUP_TOKEN=<созданный токен>`
   `GITHUB_BACKUP_BRANCH=main`
   Токен сохрани только в Render Environment, не добавляй его в проект или GitHub.
5. Сохрани изменения и дождись деплоя. В логах должны появиться сообщения о загрузке SQLite, журнала игроков и статистики.

Файлы в приватном repository
- `backups/log.txt`: Telegram ID, username, баланс, инвентарь и последние 100 транзакций, игр и действий администраторов.
- `backups/stats.json`: регистрации, онлайн/активные игроки, общий баланс, инвентарь, кейсы, исходы игр, комнаты, друзья, сообщения, донаты Stars и популярные скины.
- `backups/cs2-market.sqlite.gz`: полная база со всей историей.

Backend обновляет снимки раз в 5 минут, когда сервис работает. Из-за сна бесплатного Render последние изменения могут попасть в резервную копию с задержкой до пяти минут. GitHub Free включает приватные репозитории бесплатно, но GitHub предназначен для кода, а не баз данных; снимки ограничены размером файла 50 МБ в этом проекте и хранят Telegram ID и игровые балансы — используй только private repository. [Планы GitHub](https://github.com/pricing) · [лимиты GitHub repositories](https://docs.github.com/en/repositories/creating-and-managing-repositories/repository-limits).

Telegram Stars
Для платежей нужны BOT_TOKEN, TELEGRAM_WEBHOOK_URL и TELEGRAM_WEBHOOK_SECRET. Backend проверяет pre-checkout и сохраняет подтверждённые оплаты. [Инструкция Telegram Stars](https://core.telegram.org/bots/payments-stars).

Резервные копии в Telegram
Создай приватный канал и добавь бота администратором с правом публиковать сообщения и закреплять их. В Render → Environment задай CHANNEL_ID равным числовому ID канала (обычно начинается с -100); BOT_TOKEN — токен того же бота. Сервер собирает профили изменённых игроков в batch_<timestamp>.json (5 игроков или 5 секунд), публикует и закрепляет index.json, а при входе восстанавливает профиль из связанного файла. При SIGTERM сервер сначала отключает сокеты, затем выгружает всех игроков из памяти в канал, обновляет index.json и только после этого завершает процесс. Ожидание закрытия HTTP-соединений ограничено 3 секундами, чтобы Render не оборвал процесс до бэкапа.
Профиль содержит Telegram ID/username, баланс, инвентарь, транзакции, историю мини-игр, Premium, статус и административные действия. Используй только приватный канал, потому что данные игроков доступны его участникам.

Локальный запуск
1. Установи Node.js 20 или новее.
2. В папке backend скопируй .env.example в .env.
3. Выполни `npm install`, затем `npm start`.
4. Открой http://localhost:3000.
