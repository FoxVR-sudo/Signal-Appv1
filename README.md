# Signal App Monorepo

MVP система за граждански сигнали към полиция с две мобилни приложения и един backend.

## Mobile SDK
- Citizen app: Expo SDK 54
- Patrol app: Expo SDK 54

## Компоненти
- Citizen app: един бутон, отваря камера, изпраща снимка + GPS.
- Patrol app: входящи сигнали в реално време, статус действия.
- Backend API: прием на сигнали, auto-assignment към най-близък патрул, failover до следващ патрул.

## Изисквания
- Node.js 20+
- Corepack (вграден в Node 20)
- pnpm (през Corepack)

## Стартиране
1. Инсталиране на зависимости:
	corepack pnpm install
2. Стартиране на backend:
	corepack pnpm dev:backend
3. Стартиране на citizen app:
	export PATH="$HOME/.local/bin:$PATH" && corepack pnpm dev:citizen
4. Стартиране на patrol app:
	export PATH="$HOME/.local/bin:$PATH" && corepack pnpm dev:patrol

## API (MVP)
- GET /health
- POST /reports
- GET /patrol/incidents/live?unitId=patrol-1
- POST /patrol/incidents/:id/accept
- POST /patrol/incidents/:id/arrived
- POST /patrol/incidents/:id/close
- GET /reports/:id
- WS /ws/patrol

## Работна логика
- Нов сигнал се assign-ва автоматично към най-близък свободен патрул.
- Ако не бъде приет до 15 секунди, се reassign-ва към следващ патрул.
- Patrol app получава realtime събития и показва локално известие.

## Реален UI тест (телефон)
1. Свържи телефона и машината в една Wi-Fi мрежа.
2. Инсталирай Expo Go.
3. Сканирай QR за citizen app и patrol app от двата Metro терминала.
4. В citizen app натисни Подай сигнал, направи снимка и изпрати.
5. В patrol app провери входящия сигнал и натисни Приемам/На място/Приключи.
6. В citizen app следи статуса на последния сигнал.

## APK build (Android)
1. Увери се, че Android SDK е наличен.
2. Задай среда:
	export ANDROID_HOME="$HOME/Android/Sdk"
	export ANDROID_SDK_ROOT="$HOME/Android/Sdk"
	export PATH="$HOME/.local/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
3. Citizen debug APK:
	EXPO_PUBLIC_BACKEND_URL=http://YOUR_LAN_IP:4000 corepack pnpm android:apk:citizen
4. Patrol debug APK:
	EXPO_PUBLIC_BACKEND_URL=http://YOUR_LAN_IP:4000 corepack pnpm android:apk:patrol
5. Готовите APK файлове са в:
	apps/citizen-mobile/android/app/build/outputs/apk/debug/signal-citizen-debug.apk
	apps/patrol-mobile/android/app/build/outputs/apk/debug/signal-patrol-debug.apk

## Важно: Debug vs Release APK
- Debug APK изисква Metro dev server. Без него ще виждаш runtime грешки.
- Release APK работи самостоятелно (без Metro) и е правилният избор за реален тест на телефон.

Citizen release build:
- EXPO_PUBLIC_BACKEND_URL=http://YOUR_LAN_IP:4000 corepack pnpm android:release:citizen

Patrol release build:
- EXPO_PUBLIC_BACKEND_URL=http://YOUR_LAN_IP:4000 corepack pnpm android:release:patrol
 
