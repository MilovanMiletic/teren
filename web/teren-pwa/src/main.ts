import { bootstrapApplication } from '@angular/platform-browser';
import { appConfig } from './app/app.config';
import { App } from './app/app';
import { installPromptCapture } from './app/core/install/install-prompt';

/*
 * Before bootstrap, not inside it. Chromium fires `beforeinstallprompt` once and never replays
 * it, and it can fire while this app is still booting — bootstrap awaits a network call and Home
 * is a lazy route. A listener that started with the Home component would miss the offer on a
 * repeat visit, which is precisely the visit where installing is on the table.
 */
installPromptCapture.watch(window);

bootstrapApplication(App, appConfig).catch((err) => console.error(err));
