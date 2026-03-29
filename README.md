# Signal App Monorepo

MVP система за граждански сигнали към полиция с две мобилни приложения и един backend.

## Mobile Stack
- Citizen app: React Native 0.81 (native Android build)
- Patrol app: React Native 0.81 (native Android build)

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
3. Стартиране на citizen Metro (фиксиран порт):
	corepack pnpm dev:citizen
4. Стартиране на patrol Metro (фиксиран порт):
	corepack pnpm dev:patrol

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
- Ако не бъде приет до 120 секунди, се reassign-ва към следващ патрул.
- Patrol app получава realtime събития и показва локално известие.

## Push Notifications (Patrol)
- Patrol app регистрира Expo push token към backend: `POST /patrol/units/:unitId/push-token`.
- Backend изпраща push при `report_assigned` и `report_reassigned`.
- Push известията работят и когато patrol app не е отворено на преден план.
- За Android 13+ трябва да се даде разрешение за notifications при първо пускане.
- За Android build е задължителен Firebase файл:
	- Постави `google-services.json` в `apps/patrol-mobile/android/app/google-services.json`
	- Файлът се сваля от Firebase Console за app id `bg.signal.patrol`

## Troubleshooting Deploy (Render)
- Ако route `POST /patrol/units/:unitId/push-token` връща 404 на production URL, Render работи със стар deploy.
- От Render Dashboard: Service `signal-backend` -> `Manual Deploy` -> `Deploy latest commit`.
- След това провери:
	- `POST https://signal-backend-8pyp.onrender.com/patrol/units/patrol-1/push-token` трябва да връща `200` с `{ "ok": true }`.

## Реален тест (телефон, native)
1. Свържи телефона с USB и провери:
	adb devices
2. Вържи портовете към dev машината:
	adb reverse tcp:4000 tcp:4000
	adb reverse tcp:8081 tcp:8081
	adb reverse tcp:8085 tcp:8085
3. Стартирай backend и Metro:
	corepack pnpm dev:backend
	corepack pnpm dev:citizen
	corepack pnpm dev:patrol
4. Инсталирай citizen debug app:
	cd apps/citizen-mobile && npx react-native run-android --port 8081
5. Инсталирай patrol debug app:
	cd apps/patrol-mobile && npx react-native run-android --port 8085
6. Тест поток:
	- В citizen app: Подай сигнал (снимка + локация).
	- В patrol app: виж входящ сигнал и натисни Приемам/На място/Приключи.
	- В citizen app: следи промяната на статуса.

## APK build (Android)
1. Увери се, че Android SDK е наличен.
2. Задай среда:
	export ANDROID_HOME="$HOME/Android/Sdk"
	export ANDROID_SDK_ROOT="$HOME/Android/Sdk"
	export PATH="$HOME/.local/bin:$ANDROID_HOME/platform-tools:$ANDROID_HOME/cmdline-tools/latest/bin:$PATH"
3. Citizen debug APK:
	corepack pnpm android:apk:citizen
4. Patrol debug APK:
	corepack pnpm android:apk:patrol
5. Готовите APK файлове са в:
	apps/citizen-mobile/android/app/build/outputs/apk/debug/signal-citizen-debug.apk
	apps/patrol-mobile/android/app/build/outputs/apk/debug/signal-patrol-debug.apk

## Важно: Debug vs Release APK
- Debug APK изисква Metro dev server. Без него ще виждаш runtime грешки.
- Release APK работи самостоятелно (без Metro) и е правилният избор за реален тест на телефон.

Citizen release build:
- corepack pnpm android:release:citizen

Patrol release build:
- corepack pnpm android:release:patrol

И двата release APK едновременно:
- corepack pnpm android:release:all

Release файлове:
- apps/citizen-mobile/android/app/build/outputs/apk/release/signal-citizen-release.apk
- apps/patrol-mobile/android/app/build/outputs/apk/release/signal-patrol-release.apk

## Deploy backend на Render
Проектът е готов за Render чрез [render.yaml](render.yaml).

1. В Render създай New + Blueprint и избери това repo.
2. Render ще прочете [render.yaml](render.yaml) и ще създаде service `signal-backend`.
3. Build command:
	corepack enable && corepack pnpm install --frozen-lockfile && corepack pnpm --filter @signal/backend build
4. Start command:
	corepack pnpm --filter @signal/backend start
5. Health check:
	/health

След deploy backend URL ще бъде от вида:
- https://signal-backend.onrender.com

За мобилни release тестове без adb reverse задай:
- EXPO_PUBLIC_BACKEND_URL=https://YOUR-RENDER-HOST.onrender.com

