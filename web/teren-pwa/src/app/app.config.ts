import { registerLocaleData } from '@angular/common';
import { provideHttpClient, withFetch } from '@angular/common/http';
import localeSrLatn from '@angular/common/locales/sr-Latn';
import {
  ApplicationConfig,
  LOCALE_ID,
  inject,
  isDevMode,
  provideAppInitializer,
  provideBrowserGlobalErrorListeners,
} from '@angular/core';
import { provideRouter, withComponentInputBinding } from '@angular/router';
import { provideServiceWorker } from '@angular/service-worker';
import { provideTransloco } from '@jsverse/transloco';

import { routes } from './app.routes';
import { AppStatus } from './core/app-status.service';
import { ApiProjectSource } from './core/projects/api-project-source';
import { PROJECT_SOURCE } from './core/projects/project-source';
import { ProjectService } from './core/projects/project.service';
import { RescueService } from './core/rescue.service';
import { ActionLogService } from './core/telemetry/action-log.service';
import { UploadService } from './core/sync/upload.service';
import { AVAILABLE_LANGUAGES, LOCALE_BY_LANGUAGE, activeLanguage } from './i18n';
import { TranslocoHttpLoader } from './transloco-loader';

registerLocaleData(localeSrLatn, LOCALE_BY_LANGUAGE.sr);

export const appConfig: ApplicationConfig = {
  providers: [
    provideBrowserGlobalErrorListeners(),
    // **No `withViewTransitions()`, and that is a decision with a measurement behind it.** It was
    // in this file and was taken out: a view transition suppresses input for its whole lifetime, so
    // a real tap landing during the fade is dropped — on saved → Home the record button was dead
    // for a third of a second, which no product with a thirty-second entry can carry. Nothing in a
    // stylesheet fixes it. The arriving screen fades on its own instead (styles.css, `.screen`),
    // which costs no interactivity at all. `motion.spec.ts` pins the absence, because re-adding one
    // line here is easy and the cost is invisible until somebody measures it again.
    provideRouter(routes, withComponentInputBinding()),
    provideHttpClient(withFetch()),
    // B3: the site list now comes from `GET /api/projects`, cached locally, with the built-in
    // demo list as the last resort. Nothing above this line changed with it — which is what the
    // token was put here for in B2.
    { provide: PROJECT_SOURCE, useExisting: ApiProjectSource },
    provideTransloco({
      config: {
        availableLangs: [...AVAILABLE_LANGUAGES],
        defaultLang: activeLanguage(),
        fallbackLang: 'en',
        reRenderOnLangChange: true,
        prodMode: !isDevMode(),
      },
      loader: TranslocoHttpLoader,
    }),
    // Date and number formatting is fixed at bootstrap; switching language
    // re-renders text immediately but reformats dates only on the next load.
    { provide: LOCALE_ID, useFactory: () => LOCALE_BY_LANGUAGE[activeLanguage()] },
    provideServiceWorker('ngsw-worker.js', {
      enabled: !isDevMode(),
      registrationStrategy: 'registerWhenStable:30000',
    }),
    provideAppInitializer(() => {
      const projects = inject(ProjectService);
      const rescue = inject(RescueService);
      const status = inject(AppStatus);
      const uploads = inject(UploadService);
      const actions = inject(ActionLogService);

      rescue.watch();

      // D5: what was pressed, on which screen, and what came of it. Started here rather than in a
      // component because the interesting presses happen on screens that come and go, and because
      // the first thing worth recording is that the app started at all. It never blocks a click,
      // never throws into a handler and never competes with the upload queue — see the service.
      actions.start();

      // The sync loop is started, never awaited. It runs for the life of the app and reports on
      // the pending screen; making bootstrap wait for a network call would put the record button
      // behind the very connection this product assumes is missing.
      uploads.start();

      // Bootstrap must never be able to fail. A store that will not open (private mode, exhausted
      // quota) or a project list that will not load are conditions the app reports on screen; an
      // uncaught rejection here would abort bootstrap to a blank page, which is the one outcome a
      // foreman on a roof cannot do anything with.
      return Promise.all([
        projects.load().catch(() => undefined),
        // Assembles any recording the phone was interrupted in the middle of, then queues drafts
        // nobody came back to. Exempts whatever entry the current URL is showing.
        rescue.run().catch(() => status.reportStorageFailure()),
      ]).then(() => undefined);
    }),
  ],
};
