# cloud-test

Скрипт для мониторинга времени отклика облака, поддерживает автополучение токена, сохранение нового токена в config.json, асинхронную отправку запросов, запись в postgres. Дальнейшая обработка настроена в Grafana. 
Запуск через любой планировщик задач с помощью `deno run --allow-read --allow-env --unsafely-ignore-certificate-errors --allow-net --allow-write index.ts`
Результаты приходят в одном JSON-е

В будущем: полостью перейти на async/await, заменить interface на type
